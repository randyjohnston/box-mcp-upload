import { createSHA1 } from "hash-wasm";

export class DirectNetworkError extends Error {}
/**
 * The server decided this file belongs on the Next.js server route rather than
 * a browser upload — for example Box MCP's inline `upload_file`, which only a
 * credential holder can call. Not a failure, and not a fallback.
 */
export class ServerRouteRequired extends Error {
  constructor(readonly via: string) {
    super(`This file uploads via the Next.js server (${via}).`);
  }
}
/** Box answered, and refused: the credential lacks rights for this operation. */
export class DirectRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    message?: string,
  ) {
    super(
      code === "cors_origin_not_whitelisted"
        ? "Box refused the browser upload: this origin is not listed under CORS Domains for the Box app that minted the token."
        : `Box refused the upload (HTTP ${status}${code ? ` ${code}` : ""}). ${message ?? ""}`.trim(),
    );
  }
}

import type { RequestEvent } from "../request-event";
export type DirectEvent = RequestEvent;
export type DirectLog = (event: RequestEvent) => void;

const host = (url: string) => {
  try {
    const target = new URL(url, location.origin);
    return target.host + target.pathname;
  } catch {
    return url;
  }
};
type Prepared = {
  token: string;
  folderId: string;
  name: string;
  strategy: "simple" | "chunked";
  uploadUrl: string;
  via?: string;
  probeUrl?: string;
  newVersion?: boolean;
  directId?: string;
  partSize?: number;
};
async function control(body: Record<string, unknown>, log: DirectLog) {
  const step = `${body.action} (Next.js server)`;
  // Filled in once the response says which path the server took.
  let why =
    body.action === "prepare"
      ? "Ask the Next.js server to prepare this upload, because the browser never holds the Box credential"
      : "Ask the Next.js server to finalise this upload";
  let response: Response;
  try {
    response = await fetch("/api/direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    log({
      step,
      method: "POST",
      target: "/api/direct",
      status: "network",
      ok: false,
      transport: "Browser → Next.js server",
      reason: why,
      detail: (error as Error).message,
    });
    throw error;
  }
  const data = await response.json();
  if (body.action === "prepare")
    why =
      data.via === "box mcp get_upload_url"
        ? "Ask the Next.js server for an upload ticket from Box MCP get_upload_url: it returns a single-use URL and token, because the browser never holds the Box credential"
        : "Ask the Next.js server to create a Box upload session, because the browser never holds the Box credential";
  else
    why =
      "Ask the Next.js server to verify the uploaded parts and commit the file";
  log({
    step,
    method: "POST",
    target: "/api/direct",
    status: response.status,
    ok: response.ok,
    transport: "Browser → Next.js server",
    reason: why,
    detail:
      response.ok && body.action === "prepare"
        ? `base_upload · folder ${data.folderId} · ${data.strategy}`
        : response.ok
          ? undefined
          : data.error,
  });
  // Children after the parent, so the trace reads top-down.
  for (const request of data.requests ?? []) log(request);
  if (!response.ok)
    throw new Error(data.error ?? "Could not prepare the Box upload.");
  return data;
}
async function boxFetch(
  url: string,
  token: string,
  init: RequestInit = {},
  log: DirectLog = () => {},
  step = "request",
  why = "Direct upload, browser to Box",
) {
  const method = init.method ?? "GET";
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    // A cross-origin block and an unreachable host are indistinguishable to
    // the page: both surface as an opaque TypeError with no status.
    const blocked = error instanceof TypeError;
    const timedOut =
      error instanceof DOMException && error.name === "TimeoutError";
    log({
      transport: "Browser → Box",
      durationMs: Math.round(performance.now() - started),
      step,
      method,
      target: host(url),
      status: blocked ? "CORS / blocked" : timedOut ? "timeout" : "network",
      ok: false,
      reason:
        blocked || timedOut
          ? "The browser could not reach Box with this credential"
          : "Browser upload failed before a response arrived",
      detail: blocked
        ? `No response from ${host(url)}. Check that this origin is listed under CORS Domains for the Box app that minted the token.`
        : (error as Error).message,
    });
    if (blocked || timedOut)
      throw new DirectNetworkError("The browser could not reach Box.");
    throw error;
  }
  // On a refusal, Box names the cause in the body (for example
  // cors_origin_not_whitelisted). Surface it on the row so the trace explains
  // itself without opening the network tab.
  let detail: string | undefined;
  if (!response.ok) {
    const body = await response
      .clone()
      .json()
      .catch(() => ({}) as { code?: string; message?: string });
    detail = [body.code, body.message].filter(Boolean).join(" · ") || undefined;
  }
  log({
    transport: "Browser → Box",
    durationMs: Math.round(performance.now() - started),
    step,
    method,
    target: host(url),
    status: response.status,
    ok: response.ok,
    reason: why,
    detail,
  });
  return response;
}
async function check(response: Response) {
  if (response.ok) return;
  const body = await response
    .clone()
    .json()
    .catch(() => ({}) as { code?: string; message?: string });
  const code = typeof body.code === "string" ? body.code : undefined;
  if (response.status === 401 || response.status === 403)
    throw new DirectRefusedError(response.status, code, body.message);
  throw new Error(
    `Box rejected the upload (HTTP ${response.status}${code ? ` ${code}` : ""}).`,
  );
}
const mb = (bytes: number) =>
  (bytes / 1048576).toFixed(bytes % 1048576 === 0 ? 0 : 1);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

export async function directUpload(
  file: File,
  folder: string,
  progress: (value: number, detail: string) => void,
  log: DirectLog = () => {},
  app?: string,
): Promise<{ id: string; newVersion: boolean }> {
  const prepared: Prepared = await control(
    {
      action: "prepare",
      name: file.name,
      size: file.size,
      folder: folder || undefined,
      app,
    },
    log,
  );
  if ((prepared as { strategy?: string }).strategy === "server-inline")
    throw new ServerRouteRequired(prepared.via ?? "Next.js server");
  const { token, uploadUrl } = prepared;
  if (prepared.strategy === "simple") {
    // No reachability probe here. Box answers this endpoint with
    // `access-control-allow-methods: POST` and sends no CORS headers at all for
    // OPTIONS, so probing with OPTIONS reports "blocked" for an upload the
    // browser is in fact allowed to make. The POST carries its own preflight,
    // which is the only reachability test that reflects the real request.
    const form = new FormData();
    // A new-version upload has no parent: Box ignores it, and get_upload_url
    // returns an empty folder id for that case.
    form.append(
      "attributes",
      JSON.stringify(
        prepared.folderId
          ? { name: prepared.name, parent: { id: prepared.folderId } }
          : { name: prepared.name },
      ),
    );
    form.append("file", file, prepared.name);
    progress(0.2, "Browser is uploading to Box…");
    let response: Response;
    try {
      response = await boxFetch(
        uploadUrl,
        token,
        { method: "POST", body: form },
        log,
        "upload file",
        prepared.via === "box mcp get_upload_url"
          ? "Direct upload, browser to Box, using the single-use URL from Box MCP get_upload_url"
          : "Direct upload, browser to Box: the whole file, using the downscoped token",
      );
    } catch (error) {
      // A rejected preflight means the body was never sent, which is the
      // common case here; a mid-body drop is indistinguishable in the browser.
      // Retrying is safe either way: a same-name upload becomes a new version
      // rather than a duplicate file.
      throw error;
    }
    await check(response);
    const result = await response.json();
    if (!result.entries?.[0]?.id)
      throw new Error(
        "Box did not confirm the file. Refresh the folder before trying again.",
      );
    return {
      id: result.entries[0].id,
      newVersion: prepared.newVersion ?? false,
    };
  }
  const id = prepared.directId!;
  let committing = false;
  try {
    const probe = await boxFetch(
      prepared.probeUrl ?? uploadUrl,
      token,
      {},
      log,
      "session probe",
      "Checking the browser can reach the upload session before sending parts",
    );
    check(probe);
    await probe.body?.cancel();
    const hasher = await createSHA1();
    hasher.init();
    const partSize = prepared.partSize!;
    progress(0, "Browser is checksumming the file…");
    for (let offset = 0; offset < file.size; offset += partSize)
      hasher.update(
        new Uint8Array(
          await file.slice(offset, offset + partSize).arrayBuffer(),
        ),
      );
    const digest = base64(hasher.digest("binary"));
    let next = 0;
    let uploaded = 0;
    let stopped = false;
    const workers = await Promise.allSettled(
      Array.from({ length: 3 }, async () => {
        while (!stopped) {
          const offset = next;
          next += partSize;
          if (offset >= file.size) return;
          try {
            const chunk = await file
              .slice(offset, offset + partSize)
              .arrayBuffer();
            const partDigest = base64(
              new Uint8Array(await crypto.subtle.digest("SHA-1", chunk)),
            );
            for (let attempt = 0; ; attempt++) {
              const response = await boxFetch(
                uploadUrl,
                token,
                {
                  method: "PUT",
                  body: chunk,
                  headers: {
                    "Content-Type": "application/octet-stream",
                    Digest: `sha=${partDigest}`,
                    "Content-Range": `bytes ${offset}-${offset + chunk.byteLength - 1}/${file.size}`,
                  },
                },
                log,
                `part ${offset / partSize + 1}/${Math.ceil(file.size / partSize)} · ${mb(offset)}–${mb(Math.min(offset + partSize, file.size))} MB`,
                "Direct upload, browser to Box: one part of the file",
              );
              if (
                attempt < 3 &&
                (response.status === 429 || response.status >= 500)
              ) {
                const wait = Math.min(
                  30,
                  Math.max(
                    0,
                    Number(response.headers.get("retry-after")) || 2 ** attempt,
                  ),
                );
                await response.body?.cancel();
                await new Promise((resolve) =>
                  setTimeout(resolve, wait * 1000),
                );
                continue;
              }
              await check(response);
              await response.body?.cancel();
              break;
            }
            uploaded += chunk.byteLength;
            progress(
              (uploaded / file.size) * 0.95,
              "Browser is uploading to Box…",
            );
          } catch (error) {
            stopped = true;
            throw error;
          }
        }
      }),
    );
    const failures = workers.filter((worker) => worker.status === "rejected");
    // A real Box HTTP error must not be hidden by a simultaneous network failure.
    const failure =
      failures.find(
        (worker) => !(worker.reason instanceof DirectNetworkError),
      ) ?? failures[0];
    if (failure) throw failure.reason;
    committing = true;
    progress(0.95, "Next.js server is finalising the file in Box…");
    return await control({ action: "finish", id, digest, app }, log);
  } catch (error) {
    if (!committing) {
      // Confirm the partial session is abandoned before restarting through the backend.
      await control({ action: "finish", id, app }, log);
    }
    throw error;
  }
}
