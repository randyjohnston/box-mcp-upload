import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";

import { BoxClient, BoxApiError, retryDelayMs, sleep } from "./client";
import { assertSafeName, type BoxItem } from "./folders";

/** Harness threshold; Box recommends chunked uploads for files over 50 MB. */
export const CHUNKED_THRESHOLD = 20 * 1024 * 1024;

/** How many parts to send at once. Keeps memory bounded to POOL * part_size. */
const PART_CONCURRENCY = 3;

export type UploadProgress = {
  phase: "hashing" | "uploading" | "committing";
  bytesUploaded: number;
  totalBytes: number;
  partsDone: number;
  totalParts: number;
};

export type UploadResult = {
  id: string;
  name: string;
  size: number;
  strategy: "simple" | "chunked";
  /** True when the name already existed and we added a new version instead. */
  newVersion: boolean;
};

export type Session = {
  id: string;
  part_size: number;
  total_parts: number;
  session_endpoints: {
    upload_part: string;
    commit: string;
    abort: string;
    status: string;
    list_parts: string;
  };
};

export type UploadedPart = {
  part_id: string;
  offset: number;
  size: number;
  sha1: string;
};

/** Box wants digests as `sha=<base64 of the raw SHA-1>`. */
function digestHeader(sha1Base64: string): string {
  return `sha=${sha1Base64}`;
}

async function sha1OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha1");
  for await (const chunk of createReadStream(filePath))
    hash.update(chunk as Buffer);
  return hash.digest("base64");
}

// --- simple upload (< 20 MB) ------------------------------------------------

async function simpleUpload(
  client: BoxClient,
  filePath: string,
  fileName: string,
  folderId: string,
  size: number,
): Promise<UploadResult> {
  const handle = await open(filePath, "r");
  let bytes: Buffer;
  try {
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }

  const form = new FormData();
  form.append(
    "attributes",
    JSON.stringify({ name: fileName, parent: { id: folderId } }),
  );
  form.append("file", new Blob([new Uint8Array(bytes)]), fileName);

  try {
    const res = await client.json<{ entries: BoxItem[] }>(
      `${client.uploadUrl}/files/content`,
      { method: "POST", body: form },
    );
    const entry = res.entries[0];
    return {
      id: entry.id,
      name: entry.name,
      size,
      strategy: "simple",
      newVersion: false,
    };
  } catch (err) {
    if (
      !(err instanceof BoxApiError) ||
      err.status !== 409 ||
      !err.conflictId ||
      err.conflictType !== "file"
    )
      throw err;

    // Same name already in the folder: add a new version rather than failing.
    const versionForm = new FormData();
    versionForm.append("attributes", JSON.stringify({ name: fileName }));
    versionForm.append("file", new Blob([new Uint8Array(bytes)]), fileName);
    const res = await client.json<{ entries: BoxItem[] }>(
      `${client.uploadUrl}/files/${err.conflictId}/content`,
      { method: "POST", body: versionForm },
    );
    const entry = res.entries[0];
    return {
      id: entry.id,
      name: entry.name,
      size,
      strategy: "simple",
      newVersion: true,
    };
  }
}

// --- chunked upload (>= 20 MB) ---------------------------------------------

export async function createSession(
  client: BoxClient,
  fileName: string,
  folderId: string,
  size: number,
): Promise<{ session: Session; newVersion: boolean }> {
  const body = JSON.stringify({
    folder_id: folderId,
    file_size: size,
    file_name: fileName,
  });
  try {
    const session = await client.json<Session>(
      `${client.uploadUrl}/files/upload_sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
    );
    return { session, newVersion: false };
  } catch (err) {
    if (
      !(err instanceof BoxApiError) ||
      err.status !== 409 ||
      !err.conflictId ||
      err.conflictType !== "file"
    )
      throw err;

    // Name taken: open a session against the existing file to add a version.
    const session = await client.json<Session>(
      `${client.uploadUrl}/files/${err.conflictId}/upload_sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_size: size, file_name: fileName }),
      },
    );
    return { session, newVersion: true };
  }
}

async function uploadPart(
  client: BoxClient,
  session: Session,
  filePath: string,
  index: number,
  partSize: number,
  totalSize: number,
): Promise<UploadedPart> {
  const offset = index * partSize;
  const length = Math.min(partSize, totalSize - offset);

  const handle = await open(filePath, "r");
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(
        buffer,
        read,
        length - read,
        offset + read,
      );
      if (!bytesRead)
        throw new Error("Staged file ended before the expected size.");
      read += bytesRead;
    }
  } finally {
    await handle.close();
  }

  const sha1 = createHash("sha1").update(buffer).digest("base64");
  const lastByte = offset + length - 1;

  const res = await client.json<{ part: UploadedPart }>(
    session.session_endpoints.upload_part,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        Digest: digestHeader(sha1),
        "Content-Range": `bytes ${offset}-${lastByte}/${totalSize}`,
      },
      body: new Uint8Array(buffer),
    },
  );
  if (
    res.part.offset !== offset ||
    res.part.size !== length ||
    res.part.sha1 !== createHash("sha1").update(buffer).digest("hex")
  ) {
    throw new Error("Box returned an invalid upload part receipt.");
  }
  return res.part;
}

export async function commitSession(
  client: BoxClient,
  session: Session,
  parts: UploadedPart[],
  wholeFileSha1: string,
): Promise<BoxItem> {
  // Box may answer 202 while it assembles the parts; retry until it is ready.
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await client.fetch(session.session_endpoints.commit, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Digest: digestHeader(wholeFileSha1),
      },
      body: JSON.stringify({ parts }),
    });
    if (res.status === 202) {
      const wait = retryDelayMs(res, attempt);
      await res.body?.cancel();
      await sleep(wait);
      continue;
    }
    const body = (await res.json()) as { entries: BoxItem[] };
    return body.entries[0];
  }
  throw new Error("Box did not finish assembling the upload session in time.");
}

async function chunkedUpload(
  client: BoxClient,
  filePath: string,
  fileName: string,
  folderId: string,
  size: number,
  onProgress?: (p: UploadProgress) => void,
): Promise<UploadResult> {
  const { session, newVersion } = await createSession(
    client,
    fileName,
    folderId,
    size,
  );
  const { part_size: partSize, total_parts: totalParts } = session;

  const report = (phase: UploadProgress["phase"], partsDone: number) =>
    onProgress?.({
      phase,
      partsDone,
      totalParts,
      bytesUploaded: Math.min(partsDone * partSize, size),
      totalBytes: size,
    });

  try {
    if (
      !Number.isSafeInteger(partSize) ||
      partSize <= 0 ||
      partSize > 64 * 1024 * 1024 ||
      totalParts !== Math.ceil(size / partSize)
    ) {
      throw new Error("Box returned invalid upload session dimensions.");
    }
    report("hashing", 0);
    const wholeFileSha1 = await sha1OfFile(filePath);

    // A fixed pool of workers pulling from a shared index: bounded memory,
    // parallel throughput, and parts land in `results` at their own position.
    const results = new Array<UploadedPart>(totalParts);
    let next = 0;
    let done = 0;
    report("uploading", 0);

    let failed = false;
    const workers = await Promise.allSettled(
      Array.from(
        { length: Math.min(PART_CONCURRENCY, totalParts) },
        async () => {
          while (!failed) {
            const index = next++;
            if (index >= totalParts) return;
            try {
              results[index] = await uploadPart(
                client,
                session,
                filePath,
                index,
                partSize,
                size,
              );
              report("uploading", ++done);
            } catch (error) {
              failed = true;
              throw error;
            }
          }
        },
      ),
    );

    const failure = workers.find((worker) => worker.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    report("committing", totalParts);
    const entry = await commitSession(client, session, results, wholeFileSha1);
    return {
      id: entry.id,
      name: entry.name,
      size,
      strategy: "chunked",
      newVersion,
    };
  } catch (err) {
    // Free the partial upload on Box's side; never mask the original error.
    await client
      .fetch(session.session_endpoints.abort, { method: "DELETE" })
      .catch(() => {});
    throw err;
  }
}

// --- entry point ------------------------------------------------------------

export async function uploadFile(
  client: BoxClient,
  args: {
    filePath: string;
    fileName: string;
    folderId: string;
    onProgress?: (p: UploadProgress) => void;
  },
): Promise<UploadResult> {
  const name = assertSafeName(args.fileName, "file");
  const { size } = await stat(args.filePath);
  if (size === 0) throw new Error("Refusing to upload an empty file.");

  return size >= CHUNKED_THRESHOLD
    ? chunkedUpload(
        client,
        args.filePath,
        name,
        args.folderId,
        size,
        args.onProgress,
      )
    : simpleUpload(client, args.filePath, name, args.folderId, size);
}
