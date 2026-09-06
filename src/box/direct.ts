import { randomUUID } from "node:crypto";
import { BoxClient, BoxApiError } from "./client";
import { requestToken, type TokenProvider } from "./auth";
import type { AuthApp } from "./config";
import { assertSafeName, resolveFolder, type BoxItem } from "./folders";
import {
  CHUNKED_THRESHOLD,
  createSession,
  commitSession,
  type Session,
  type UploadedPart,
} from "./upload";
import { HttpError } from "../errors";

type PendingUpload = {
  owner: string;
  expiresAt: number;
  session: Session;
  newVersion: boolean;
  size: number;
};
const state = globalThis as typeof globalThis & {
  boxDirectUploads?: Map<string, PendingUpload>;
};
const pending = (state.boxDirectUploads ??= new Map());

export async function prepareDirect(
  client: BoxClient,
  auth: TokenProvider,
  owner: string,
  name: string,
  size: number,
  folder?: string,
  app?: AuthApp,
) {
  const safeName = assertSafeName(name, "file");
  const folderId = (await resolveFolder(client, folder, true))!;
  const scoped = await requestToken(
    {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: await auth.getAccessToken(),
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "base_upload",
      resource: `https://api.box.com/2.0/folders/${folderId}`,
    },
    app,
  );
  if (
    !scoped.restrictedTo?.length ||
    scoped.restrictedTo.some(
      (restriction) =>
        restriction.scope !== "base_upload" ||
        restriction.object.type !== "folder" ||
        restriction.object.id !== folderId,
    )
  ) {
    throw new HttpError(
      502,
      "Box did not confirm an upload-only token restricted to this folder. Use a compatible OAuth app.",
    );
  }
  const common = { token: scoped.accessToken, folderId, name: safeName };
  if (size < CHUNKED_THRESHOLD) {
    let fileId: string | undefined;
    try {
      const response = await client.fetch("/files/content", {
        method: "OPTIONS",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: safeName,
          size,
          parent: { id: folderId },
        }),
      });
      await response.body?.cancel();
    } catch (error) {
      if (
        !(error instanceof BoxApiError) ||
        error.status !== 409 ||
        !error.conflictId ||
        error.conflictType !== "file"
      )
        throw error;
      fileId = error.conflictId;
    }
    return {
      ...common,
      strategy: "simple" as const,
      newVersion: Boolean(fileId),
      uploadUrl: `${client.uploadUrl}/files/${fileId ? `${fileId}/` : ""}content`,
      size,
    };
  }
  for (const [id, entry] of pending)
    if (entry.expiresAt <= Date.now()) {
      pending.delete(id);
      // Box expires abandoned sessions; don't retain credentials in this registry.
    }
  if (
    [...pending.values()].filter((value) => value.owner === owner).length >=
      5 ||
    pending.size >= 1000
  ) {
    throw new HttpError(
      429,
      "Too many pending direct uploads. Please try again later.",
    );
  }
  const { session, newVersion } = await createSession(
    client,
    safeName,
    folderId,
    size,
  );
  if (
    !Number.isSafeInteger(session.part_size) ||
    session.part_size <= 0 ||
    session.part_size > 64 * 1024 * 1024 ||
    session.total_parts !== Math.ceil(size / session.part_size)
  ) {
    await client
      .fetch(session.session_endpoints.abort, { method: "DELETE" })
      .catch(() => undefined);
    throw new Error("Invalid Box upload session.");
  }
  const directId = randomUUID();
  pending.set(directId, {
    owner,
    session,
    newVersion,
    size,
    expiresAt: Date.now() + 15 * 60_000,
  });
  return {
    ...common,
    strategy: "chunked" as const,
    directId,
    partSize: session.part_size,
    uploadUrl: session.session_endpoints.upload_part,
    probeUrl: session.session_endpoints.status,
  };
}

export async function finishDirect(
  client: BoxClient,
  owner: string,
  id: string,
  digest?: string,
) {
  const entry = pending.get(id);
  if (!entry || entry.owner !== owner || entry.expiresAt <= Date.now())
    throw new HttpError(404, "Direct upload session not found.");
  if (!digest) {
    try {
      await client.fetch(entry.session.session_endpoints.abort, {
        method: "DELETE",
      });
    } catch (error) {
      if (!(error instanceof BoxApiError) || error.status !== 404) throw error;
    }
    pending.delete(id);
    return { aborted: true };
  }
  pending.delete(id); // Claim once; a second commit cannot race this one.
  const { session } = entry;
  try {
    const parts: UploadedPart[] = [];
    let offset = 0;
    do {
      const url = new URL(session.session_endpoints.list_parts);
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("limit", "1000");
      const page = await client.json<{
        entries: UploadedPart[];
        total_count: number;
      }>(url.href);
      if (!page.entries.length) break;
      parts.push(...page.entries);
      offset += page.entries.length;
      if (offset >= page.total_count) break;
    } while (parts.length <= session.total_parts);
    parts.sort((a, b) => a.offset - b.offset);
    if (
      parts.length !== session.total_parts ||
      parts.some(
        (part, i) =>
          part.offset !== i * session.part_size ||
          part.size !== Math.min(session.part_size, entry.size - part.offset),
      )
    ) {
      throw new HttpError(
        409,
        "Upload parts are incomplete. Please select the file again.",
      );
    }
    const file: BoxItem = await commitSession(client, session, parts, digest);
    return {
      id: file.id,
      name: file.name,
      size: entry.size,
      strategy: "chunked",
      newVersion: entry.newVersion,
    };
  } catch (error) {
    await client
      .fetch(session.session_endpoints.abort, { method: "DELETE" })
      .catch(() => undefined);
    throw error;
  }
}
