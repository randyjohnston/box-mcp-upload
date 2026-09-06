import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  lstat,
  open,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { HttpError } from "./errors";
import { assertSafeName } from "./box/folders";

const UPLOAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type StagedMeta = {
  fileName: string;
  size: number;
  owner: string;
  createdAt: number;
};
export function stagingDir(): string {
  return path.resolve(
    /* turbopackIgnore: true */ process.env.STAGING_DIR ||
      path.join(process.cwd(), ".staging"),
  );
}
function pathsFor(id: string) {
  if (!UPLOAD_ID.test(id)) throw new HttpError(400, "Invalid upload ID.");
  const base = path.join(/* turbopackIgnore: true */ stagingDir(), id);
  return { data: `${base}.bin`, meta: `${base}.json`, lock: `${base}.lock` };
}
const globalStaging = globalThis as typeof globalThis & {
  boxStagingActive?: number;
};

export async function stageUpload(
  body: ReadableStream<Uint8Array> | Readable,
  fileName: string,
  maxBytes: number,
  owner = "mcp",
) {
  const safe = assertSafeName(fileName, "file");
  if ((globalStaging.boxStagingActive ?? 0) >= 3)
    throw new HttpError(429, "Too many uploads. Please try again shortly.");
  globalStaging.boxStagingActive = (globalStaging.boxStagingActive ?? 0) + 1;
  const uploadId = randomUUID();
  const { data, meta } = pathsFor(uploadId);
  let size = 0;
  try {
    await mkdir(stagingDir(), { recursive: true, mode: 0o700 });
    await sweepStale();
    const entries = await readdir(stagingDir());
    const sizes = await Promise.all(
      entries
        .filter((e) => e.endsWith(".bin"))
        .map(
          async (entry) =>
            (
              await lstat(
                path.join(/* turbopackIgnore: true */ stagingDir(), entry),
              ).catch(() => null)
            )?.size ?? 0,
        ),
    );
    if (
      sizes.length >= 100 ||
      sizes.reduce((sum, bytes) => sum + bytes, 0) >= 2 * 1024 ** 3
    ) {
      throw new HttpError(
        507,
        "Temporary upload storage is full. Try again later.",
      );
    }
    const source =
      body instanceof Readable ? body : Readable.fromWeb(body as never);
    async function* limit(chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        size += chunk.length;
        if (size > maxBytes)
          throw new HttpError(413, "File exceeds the upload size limit.");
        yield chunk;
      }
    }
    await pipeline(
      source,
      limit,
      createWriteStream(data, { flags: "wx", mode: 0o600 }),
    );
    if (!size) throw new HttpError(400, "Empty files cannot be uploaded.");
    await writeFile(
      meta,
      JSON.stringify({
        fileName: safe,
        size,
        owner,
        createdAt: Date.now(),
      } satisfies StagedMeta),
      { flag: "wx", mode: 0o600 },
    );
    return { uploadId, size };
  } catch (error) {
    await discardUpload(uploadId);
    throw error;
  } finally {
    globalStaging.boxStagingActive!--;
  }
}

export async function readStaged(id: string, owner = "mcp") {
  const paths = pathsFor(id);
  const [info, raw] = await Promise.all([
    lstat(paths.data).catch(() => null),
    readFile(/* turbopackIgnore: true */ paths.meta, "utf8").catch(() => null),
  ]);
  if (!info?.isFile() || !raw)
    throw new HttpError(404, "Staged upload not found.");
  const meta = JSON.parse(raw) as StagedMeta;
  if (meta.owner !== owner || meta.createdAt < Date.now() - 6 * 60 * 60 * 1000)
    throw new HttpError(404, "Staged upload not found.");
  if (info.size !== meta.size)
    throw new HttpError(
      409,
      "Staged file changed. Please select the file again.",
    );
  return { filePath: paths.data, meta };
}

export async function claimUpload(id: string, owner: string) {
  const staged = await readStaged(id, owner);
  const { lock } = pathsFor(id);
  try {
    await (await open(/* turbopackIgnore: true */ lock, "wx", 0o600)).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new HttpError(409, "This upload is already being processed.");
    throw error;
  }
  return staged;
}
export async function discardUpload(id: string) {
  await Promise.all(
    Object.values(pathsFor(id)).map((file) => rm(file, { force: true })),
  );
}
export async function sweepStale(maxAgeMs = 6 * 60 * 60 * 1000) {
  const root = stagingDir();
  for (const entry of await readdir(root).catch(() => [] as string[])) {
    const id = entry.replace(/\.(bin|json|lock)$/, "");
    if (!UPLOAD_ID.test(id)) continue;
    const paths = pathsFor(id);
    const locked = await lstat(paths.lock).catch(() => null);
    if (locked && locked.mtimeMs > Date.now() - maxAgeMs) continue;
    const info = await lstat(
      path.join(/* turbopackIgnore: true */ root, entry),
    ).catch(() => null);
    if (info && info.mtimeMs < Date.now() - maxAgeMs) await discardUpload(id);
  }
}
