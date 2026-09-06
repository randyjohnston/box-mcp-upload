import type { DirectLog } from "./direct-upload";

export async function jsonRequest(
  url: string,
  init?: RequestInit,
  log?: DirectLog,
) {
  const started = performance.now();
  let response: Response | undefined;
  try {
    response = await fetch(url, init);
    const body = await response.json();
    for (const event of body.requests ?? []) log?.(event);
    if (!response.ok) throw new Error(body.error ?? "The request failed.");
    return body;
  } finally {
    log?.({
      step: "Next.js API request",
      method: init?.method ?? "GET",
      target: url.split("?")[0],
      status: response?.status ?? "network",
      ok: response?.ok ?? false,
      durationMs: Math.round(performance.now() - started),
      transport: "Browser → Next.js server",
      reason: "Browser calls this app's own Next.js API",
    });
  }
}

export function stageFile(
  file: File,
  onProgress: (value: number) => void,
  log: DirectLog,
): Promise<{ uploadId: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.timeout = 10 * 60_000;
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      log({
        step: "save temporary file (Next.js server)",
        method: "POST",
        target: "/api/uploads",
        status: xhr.status,
        ok: xhr.status >= 200 && xhr.status < 300,
        transport: "Browser → Next.js server",
        reason:
          "Fallback: bytes go to the Next.js server, which uploads them to Box",
      });
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300)
          throw new Error(body.error ?? "File transfer failed.");
        if (typeof body.uploadId !== "string")
          throw new Error("Invalid upload response.");
        resolve(body);
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => {
      log({
        step: "save temporary file (Next.js server)",
        method: "POST",
        target: "/api/uploads",
        status: "network",
        ok: false,
      });
      reject(new Error("Connection lost. Please select the file again."));
    };
    xhr.ontimeout = () =>
      reject(new Error("File transfer timed out. Please try again."));
    xhr.send(file);
  });
}

export async function commitFile(
  id: string,
  folder: string,
  onProgress: (value: number, detail: string) => void,
  log: DirectLog,
  app?: string,
) {
  const response = await fetch(`/api/uploads/${id}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder: folder || undefined, app }),
    signal: AbortSignal.timeout(16 * 60_000),
  });
  log({
    step: "upload to Box (Next.js server)",
    method: "POST",
    target: `/api/uploads/${id}/commit`,
    status: response.status,
    ok: response.ok,
    transport: "Browser → Next.js server",
    reason:
      "Fallback: the Next.js server uploads to Box with the MCP tool box_upload_file",
  });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "Upload could not start.");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done)
        throw new Error(
          "Connection ended before confirmation. Refresh the folder before uploading again.",
        );
      buffer += value;
      let split: number;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? "{}");
        if (event === "request") {
          log(data);
          continue;
        }
        if (event === "error") {
          log({
            step: "App MCP tool result",
            transport: "Next.js server → in-process MCP",
            method: "MCP",
            target: "box_upload_file",
            status: "failed",
            ok: false,
            detail: data.message,
          });
          throw new Error(data.message);
        }
        if (event === "done") {
          log({
            step: "App MCP tool result",
            transport: "Next.js server → in-process MCP",
            method: "MCP",
            target: "box_upload_file",
            status: "done",
            ok: true,
          });
          return data as { id: string; newVersion: boolean };
        }
        if (event === "progress")
          onProgress(
            data.total ? Math.min(1, data.progress / data.total) : 0,
            data.message === "hashing"
              ? "Next.js server is checksumming the file…"
              : data.message === "committing"
                ? "Next.js server is finalising the file in Box…"
                : "Next.js server is uploading to Box…",
          );
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
