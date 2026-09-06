"use client";

import {
  directUpload,
  DirectNetworkError,
  DirectRefusedError,
  ServerRouteRequired,
  type DirectLog,
} from "./direct-upload";
import { jsonRequest, stageFile, commitFile } from "./server-upload";
import AuthWorkbench, {
  APP_LABEL,
  type SessionInfo,
  type AuthApp,
} from "./AuthWorkbench";
import RequestLog, { type Attempt } from "./RequestLog";
import { useCallback, useEffect, useRef, useState } from "react";

type Transfer = {
  key: string;
  name: string;
  size: number;
  phase: "queued" | "staging" | "uploading" | "done" | "error";
  progress: number;
  detail: string;
};
type BoxFile = { id: string; name: string; size?: number; type: string };
const MB = 1024 * 1024;
function bytes(value: number) {
  return value >= MB
    ? `${(value / MB).toFixed(1)} MB`
    : `${Math.ceil(value / 1024)} KB`;
}

export default function BoxUploader() {
  const [session, setSession] = useState<SessionInfo>();
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState("");
  const [folder, setFolder] = useState("Uploads");
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [files, setFiles] = useState<BoxFile[]>([]);
  const [listedFolderId, setListedFolderId] = useState<string>();
  const [listingError, setListingError] = useState("");
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Set once the browser proves it cannot reach Box directly (CORS or network).
  // Later files skip the doomed direct attempt and proxy through the server.
  const [allowFallback, setAllowFallback] = useState(true);
  const [directBlocked, setDirectBlocked] = useState<Set<AuthApp>>(new Set());
  const directBlockedRef = useRef<Set<AuthApp>>(new Set());
  const sessionRef = useRef<SessionInfo | undefined>(undefined);
  sessionRef.current = session;
  const historyLoaded = useRef(false);
  const authRecorded = useRef(false);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const folderRef = useRef(folder);
  folderRef.current = folder;
  const listingSequence = useRef(0);
  const queue = useRef(Promise.resolve());
  const busy = transfers.some((t) => !["done", "error"].includes(t.phase));
  // A configured app that is not connected yet: connecting it is what enables
  // the credential-retry step, so the blocked notice can offer exactly that.
  const viaMcp = session?.primaryApp === "mcp";
  // Which Box account this listing belongs to: a service account has its own
  // tree, separate from any person's Box.
  const primaryIdentity = session?.apps.find(
    (entry) => entry.app === session.primaryApp,
  )?.identity;
  const unconnectedApp = session?.apps.find(
    (entry) => entry.configured && !entry.connected,
  )?.app;

  const record = useCallback(
    (
      route: string,
      file: string,
      reason = "Browser upload attempted first",
    ): DirectLog =>
      (event) =>
        setAttempts((previous) =>
          [
            ...previous,
            {
              ...event,
              route: event.credential ?? route,
              reason: event.reason ?? reason,
              file,
              key: crypto.randomUUID(),
              time: new Date().toLocaleTimeString(),
            },
          ].slice(-120),
        ),
    [],
  );

  useEffect(() => {
    try {
      const saved = JSON.parse(
        sessionStorage.getItem("box-request-history") ?? "[]",
      );
      if (Array.isArray(saved)) setAttempts(saved.slice(-120));
    } catch {
      /* No usable history. */
    }
    historyLoaded.current = true;
  }, []);
  useEffect(() => {
    try {
      if (historyLoaded.current)
        sessionStorage.setItem("box-request-history", JSON.stringify(attempts));
    } catch {
      /* Storage can be disabled. */
    }
  }, [attempts]);

  const loadSession = useCallback(async () => {
    try {
      const data: SessionInfo = await jsonRequest("/api/auth/session");
      setSession(data);
      if (!authRecorded.current && data.connected) {
        authRecorded.current = true;
        const label = data.primaryApp ? APP_LABEL[data.primaryApp] : "Platform CCG";
        for (const event of data.authEvents ?? [])
          record(
            label,
            "Authentication",
            "Explicit sign-in with the selected app",
          )(event);
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to load connection settings.",
      );
    }
  }, [record]);
  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const refresh = useCallback(
    async (name: string) => {
      const sequence = ++listingSequence.current;
      setLoading(true);
      setListingError("");
      try {
        const label = sessionRef.current?.primaryApp
          ? APP_LABEL[sessionRef.current.primaryApp]
          : "Platform CCG";
        const body = await jsonRequest(
          `/api/files?folder=${encodeURIComponent(name)}`,
          undefined,
          record(label, name || "Root", "Configured: local MCP folder tool"),
        );
        if (sequence === listingSequence.current) {
          setFiles(body.items.filter((item: BoxFile) => item.type === "file"));
          setListedFolderId(body.folderId);
        }
      } catch (error) {
        if (sequence === listingSequence.current) {
          setFiles([]);
          setListingError(
            error instanceof Error ? error.message : "Unable to load files.",
          );
        }
      } finally {
        if (sequence === listingSequence.current) setLoading(false);
      }
    },
    [record],
  );
  useEffect(() => {
    if (!session?.connected) return;
    setFiles([]);
    const timer = setTimeout(() => void refresh(folder), 300);
    return () => {
      clearTimeout(timer);
      listingSequence.current++;
    };
  }, [folder, session?.connected, session?.primaryApp, session?.mode, refresh]);

  async function switchApp(app: AuthApp, password?: string) {
    setAuthBusy(true);
    setError("");
    try {
      const body = await jsonRequest(
        "/api/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app, password }),
        },
        record(
          APP_LABEL[app],
          "Authentication",
          "Intentional: select application",
        ),
      );
      if (body.url) window.location.assign(body.url);
      else {
        authRecorded.current = false;
        setFiles([]);
        setTransfers([]);
        directBlockedRef.current = new Set();
        setDirectBlocked(new Set());
        await loadSession();
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not switch Box app.",
      );
    } finally {
      setAuthBusy(false);
    }
  }

  async function disconnect() {
    setAuthBusy(true);
    setError("");
    try {
      await jsonRequest(
        "/api/auth/logout",
        { method: "POST" },
        record(
          session?.primaryApp ? APP_LABEL[session.primaryApp] : "Platform CCG",
          "Authentication",
          "Intentional: disconnect",
        ),
      );
      setFiles([]);
      setTransfers([]);
      authRecorded.current = false;
      directBlockedRef.current = new Set();
      setDirectBlocked(new Set());
      await loadSession();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Sign-out failed.");
    } finally {
      setAuthBusy(false);
    }
  }

  function accept(list: FileList | null) {
    if (!session?.connected) return;
    const destination = folder.trim(); // Capture when selected, before staging or queuing.
    const selected = Array.from(list ?? []);
    if (
      selected.length +
        transfers.filter((item) => !["done", "error"].includes(item.phase))
          .length >
      20
    ) {
      setError("Choose up to 20 files at a time.");
      return;
    }
    for (const file of selected) {
      const key = crypto.randomUUID();
      const invalid = file.size === 0 || file.size > session.maxUploadBytes;
      setTransfers((previous) => [
        ...previous,
        {
          key,
          name: file.name,
          size: file.size,
          phase: invalid ? "error" : "queued",
          progress: 0,
          detail: invalid
            ? `Choose a non-empty file up to ${bytes(session.maxUploadBytes)}.`
            : "Waiting to transfer…",
        },
      ]);
      if (invalid) continue;
      const patch = (changes: Partial<Transfer>) =>
        setTransfers((previous) =>
          previous.map((item) =>
            item.key === key ? { ...item, ...changes } : item,
          ),
        );
      queue.current = queue.current.then(async () => {
        // Policy, exactly as the UI declares it:
        //  1. try the direct path with each connected credential in turn —
        //     MCP first, then the platform app, because CORS rules and scopes
        //     are per Box application;
        //  2. if none succeed, and "Allow Next.js server fallback" is on,
        //     route the bytes through the Next.js server instead.
        const label = (app?: AuthApp) =>
          app ? APP_LABEL[app] : "Platform CCG";
        const order = [session.primaryApp, session.fallbackApp].filter(
          (app): app is AuthApp => Boolean(app),
        );
        // Remembering a blocked credential is an optimisation, not a verdict:
        // if skipping would leave nothing to attempt, attempt everything again
        // rather than failing without making a single request.
        const unblocked = order.filter(
          (app) => !directBlockedRef.current.has(app),
        );
        const candidates = unblocked.length ? unblocked : order;
        const retryingBlocked = unblocked.length === 0 && order.length > 0;

        const viaServer = async (app?: AuthApp, why?: string) => {
          const serverLog = record(
            label(app),
            file.name,
            why ??
              "Fallback: the browser could not upload, so the Next.js server carries the bytes",
          );
          patch({
            phase: "staging",
            progress: 0,
            detail: "Transferring via the Next.js server…",
          });
          const { uploadId } = await stageFile(
            file,
            (value) => patch({ progress: value * 0.25 }),
            serverLog,
          );
          patch({
            phase: "uploading",
            progress: 0.25,
            detail: "Transferring via the Next.js server…",
          });
          return commitFile(
            uploadId,
            destination,
            (value, detail) => patch({ progress: 0.25 + value * 0.7, detail }),
            serverLog,
            app,
          );
        };

        try {
          let result: { id: string; newVersion: boolean } | undefined;
          let path = "";
          let refusedPrimary = false;
          let lastFailure: unknown;

          for (const app of candidates) {
            const isRetry = result === undefined && app !== candidates[0];
            const directLog = record(
              label(app),
              file.name,
              isRetry
                ? `Credential fallback: ${label(candidates[0])} failed, so the browser retries with ${label(app)}`
                : retryingBlocked
                  ? `${label(app)} failed earlier in this tab, but nothing else is connected, so it is retried`
                  : "Browser uploads first, as configured",
            );
            patch({
              phase: "uploading",
              detail: isRetry
                ? `Browser is retrying with ${label(app)}…`
                : "Opening a browser connection to Box…",
            });
            try {
              result = await directUpload(
                file,
                destination,
                (progress, detail) => patch({ progress, detail }),
                directLog,
                app,
              );
              path = `uploaded by the browser · ${label(app)}`;
              break;
            } catch (error) {
              // The server chose the Next.js route for this file (Box MCP's
              // inline upload_file). Take it regardless of the fallback
              // toggle: nothing failed, and no other credential would help.
              if (error instanceof ServerRouteRequired) {
                result = await viaServer(
                  app,
                  `Chosen route: ${error.via} takes the content in one call, which only a credential holder can make`,
                );
                path = `uploaded by the Next.js server · ${label(app)}`;
                break;
              }
              const blocked = error instanceof DirectNetworkError;
              const refused = error instanceof DirectRefusedError;
              if (!blocked && !refused) throw error;
              lastFailure = error;
              // A blocked browser stays blocked for this credential; a refusal
              // is about rights, so do not retry it either.
              directBlockedRef.current.add(app);
              setDirectBlocked(new Set(directBlockedRef.current));
              if (app === session.primaryApp && refused) refusedPrimary = true;
            }
          }

          if (!result) {
            if (!allowFallback) {
              const cause =
                lastFailure instanceof Error
                  ? lastFailure.message
                  : "No connected Box credential could upload this file.";
              throw new Error(
                `${cause} Next.js server fallback is off, so the upload stopped.`,
              );
            }
            // A refused credential will be refused again server-side, so
            // prefer the one that was not refused.
            const serverApp =
              refusedPrimary && session.fallbackApp
                ? session.fallbackApp
                : session.primaryApp;
            result = await viaServer(serverApp);
            path = `uploaded by the Next.js server · ${label(serverApp)}`;
          }

          patch({
            phase: "done",
            progress: 1,
            detail: `Saved to Box, ${path}${result.newVersion ? " · New version" : ""}`,
          });
          if (folderRef.current.trim() === destination)
            await refresh(destination);
        } catch (error) {
          patch({
            phase: "error",
            detail: error instanceof Error ? error.message : "Upload failed.",
          });
        }
      });
    }
  }

  return (
    <>
      <header className="workspace-header">
        <div>
          <h1>Box upload test harness</h1>
          <p>
            MCP integration and platform OAuth · authentication, uploads, and
            request traces
          </p>
        </div>
        <span
          className="connection"
          data-connected={session?.connected ?? false}
        >
          <i />
          {session?.connected
            ? `Box connected${session.primaryApp ? ` · ${APP_LABEL[session.primaryApp]}` : " · Platform CCG"}`
            : "Not connected"}
        </span>
      </header>
      <AuthWorkbench
        session={session}
        busy={busy || authBusy}
        blocked={directBlocked.size > 0}
        connect={(app, password) => void switchApp(app, password)}
        disconnect={() => void disconnect()}
        retry={() => {
          directBlockedRef.current = new Set();
          setDirectBlocked(new Set());
        }}
        inspect={async () => {
          const label = session?.primaryApp ? APP_LABEL[session.primaryApp] : "Platform CCG";
          const result = await jsonRequest(
            "/api/connection",
            undefined,
            record(label, "MCP tools", "Intentional: hosted MCP inspection"),
          );
          return result;
        }}
      />
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {directBlocked.size > 0 && (
        <div className="notice" role="status">
          Browser uploads to Box failed for{" "}
          {[...directBlocked].map((app) => APP_LABEL[app]).join(" and ")}
          {allowFallback
            ? "; files are routed via the Next.js server instead."
            : "; server fallback is off, so uploads stop here."}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              directBlockedRef.current = new Set();
              setDirectBlocked(new Set());
            }}
          >
            Retry browser upload
          </button>
          {unconnectedApp && (
            <>
              {" "}
              <button
                className="text-button"
                disabled={authBusy || busy}
                onClick={() => void switchApp(unconnectedApp)}
              >
                Connect {APP_LABEL[unconnectedApp]} to retry with a second
                credential
              </button>
            </>
          )}
        </div>
      )}
      <div className="workspace-grid">
        <section className="card upload-card" aria-labelledby="upload-title">
          <div className="section-heading">
            <div>
              <h2 id="upload-title">Upload workbench</h2>
            </div>
            <span className="small-badge">Browser uploads first</span>
          </div>
          {!session?.connected ? (
            <div className="connect-panel">
              <h3>Connect a Box application above to upload</h3>
              <ol className="policy-list">
                <li>The browser uploads to Box.</li>
                <li>
                  {allowFallback
                    ? "If the browser cannot, the Next.js server uploads the file."
                    : "If the browser cannot, the upload stops. Next.js server fallback is off."}
                </li>
              </ol>
            </div>
          ) : (
            <>
              <label className="field-label" htmlFor="folder">
                Destination folder
              </label>
              <div className="folder-field">
                <span aria-hidden="true">▱</span>
                <input
                  id="folder"
                  value={folder}
                  maxLength={255}
                  disabled={busy}
                  onChange={(event) => setFolder(event.target.value)}
                  placeholder="Root folder"
                />
              </div>
              <p className="field-help">
                Created if missing, inside root folder{" "}
                <code>{session?.rootFolderId ?? "0"}</code>
                {primaryIdentity ? ` in ${primaryIdentity.name}` : ""}. Matching
                file names create a new version.
              </p>
              <button
                type="button"
                className="dropzone"
                data-active={dragging}
                onClick={() => input.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  accept(event.dataTransfer.files);
                }}
              >
                <span className="upload-symbol" aria-hidden="true">
                  ↥
                </span>
                <strong>Drop your files here</strong>
                <span>
                  or <b>browse files</b> on your device
                </span>
                <small>Up to {bytes(session.maxUploadBytes)} per file</small>
              </button>
              <input
                ref={input}
                type="file"
                multiple
                aria-label="Choose files"
                className="visually-hidden"
                onChange={(event) => {
                  accept(event.target.files);
                  event.target.value = "";
                }}
              />
            </>
          )}
        </section>
        <aside className="card details-card">
          <h2>Transfer configuration</h2>
          <label className="toggle-field">
            <input
              type="checkbox"
              checked={allowFallback}
              disabled={busy}
              onChange={(event) => setAllowFallback(event.target.checked)}
            />{" "}
            Let the Next.js server carry file bytes
          </label>
          <p className="field-help">
            Applies only to the file bytes, and only after every connected
            credential has failed to upload from the browser. With this off, a
            failed browser upload stops.
          </p>
          <dl>
            <div>
              <dt>Upload order</dt>
              <dd>
                {session?.connected ? (
                  <ol className="policy-list">
                    {[session.primaryApp, session.fallbackApp]
                      .filter((app): app is AuthApp => Boolean(app))
                      .map((app, index) => (
                        <li key={app}>
                          {index === 0 ? "Browser uploads" : "Browser retries"}{" "}
                          with <strong>{APP_LABEL[app]}</strong>
                        </li>
                      ))}
                    <li data-off={!allowFallback}>
                      {allowFallback
                        ? "Next.js server carries the bytes"
                        : "Upload stops (server may not carry bytes)"}
                    </li>
                  </ol>
                ) : (
                  "Not connected"
                )}
              </dd>
            </div>
            <div>
              <dt>Always on the Next.js server</dt>
              <dd>
                {viaMcp
                  ? "Every Box MCP tool call"
                  : "Folder lookup, scoped token, upload session, commit"}
                <br />
                <span className="muted-note">
                  These need the full Box credential, which the browser never
                  holds. The setting above does not change them.
                </span>
              </dd>
            </div>
            {viaMcp ? (
              <>
                <div>
                  <dt>Box MCP tools used</dt>
                  <dd>
                    <code>who_am_i</code> · <code>search_folders_by_name</code>{" "}
                    · <code>create_folder</code> ·{" "}
                    <code>list_folder_content_by_folder_id</code> ·{" "}
                    <code>upload_file</code> · <code>get_upload_url</code>
                    <br />
                    <span className="muted-note">
                      No REST call is made on this path.
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Which upload tool</dt>
                  <dd>
                    Text up to 256 KiB → <code>upload_file</code>, inline in one
                    call, sent by the Next.js server rather than the browser
                    <br />
                    Anything else → <code>get_upload_url</code>, then one POST
                    of the whole file
                    <br />
                    <span className="muted-note">
                      That POST uses <code>multipart/form-data</code> — an
                      encoding for a single request carrying the attributes and
                      the bytes. It is not a chunked upload: Box&rsquo;s MCP
                      surface publishes no session, part or commit tool, so
                      there is no splitting, no per-part retry and no resume.
                      The URL and token are single-use and expire after 10
                      minutes, which is the real limit on very large files.
                    </span>
                  </dd>
                </div>
              </>
            ) : (
              <>
                <div>
                  <dt>Browser access</dt>
                  <dd>
                    <code>base_upload</code> · destination folder only
                  </dd>
                </div>
                <div>
                  <dt>Files ≥ 20 MiB</dt>
                  <dd>
                    Chunked whichever uploads · 3 workers
                    <br />
                    <span className="muted-note">
                      Under 20 MiB the browser posts to{" "}
                      <code>upload.box.com</code>, which enforces the app&rsquo;s
                      CORS Domains list and answers{" "}
                      <code>403 cors_origin_not_whitelisted</code> when this
                      origin is missing. Chunked parts go to{" "}
                      <code>upload.app.box.com</code>, which accepted parts here
                      without it. List this origin on every Box app you connect.
                    </span>
                  </dd>
                </div>
              </>
            )}
            <div>
              <dt>Retry triggers</dt>
              <dd>
                CORS, DNS, filtering, timeout — or Box answering 401/403
                <br />
                <span className="muted-note">
                  Both are per Box application, so the other credential is
                  tried before the Next.js server.
                </span>
              </dd>
            </div>
          </dl>
          {session?.connected && (
            <button
              className="secondary"
              disabled={busy || authBusy}
              onClick={() => void disconnect()}
            >
              Disconnect
            </button>
          )}
        </aside>
      </div>
      {transfers.length > 0 && (
        <section className="card transfers" aria-labelledby="transfers-title">
          <div className="section-heading">
            <h2 id="transfers-title">
              Transfers <span className="count">{transfers.length}</span>
            </h2>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => setTransfers([])}
            >
              Clear completed
            </button>
          </div>
          {transfers.map((item) => (
            <div className="transfer" key={item.key}>
              <div className="file-symbol" aria-hidden="true">
                ▤
              </div>
              <div className="transfer-body">
                <div className="file-heading">
                  <strong>{item.name}</strong>
                  <span>{bytes(item.size)}</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={`${item.name} upload progress`}
                  aria-valuenow={Math.round(item.progress * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="progress"
                  data-phase={item.phase}
                >
                  <span style={{ width: `${item.progress * 100}%` }} />
                </div>
                <p
                  className="transfer-status"
                  data-phase={item.phase}
                  role={item.phase === "error" ? "alert" : "status"}
                >
                  {item.detail}
                </p>
              </div>
            </div>
          ))}
        </section>
      )}
      <section className="card library" aria-labelledby="library-title">
        <div className="section-heading">
          <div>
            <h2 id="library-title">
              Files in Box <span className="count">{files.length}</span>
            </h2>
            {session?.connected && (
              <p className="library-scope">
                {folder.trim() || "root folder"}
                {listedFolderId && (
                  <>
                    {" "}
                    <code>{listedFolderId}</code>
                  </>
                )}
                {primaryIdentity && (
                  <>
                    {" · "}
                    <strong>{primaryIdentity.name}</strong>{" "}
                    <span className="muted-note">
                      ({primaryIdentity.login})
                    </span>
                  </>
                )}
              </p>
            )}
          </div>
          <button
            className="text-button"
            disabled={!session?.connected || loading}
            onClick={() => void refresh(folder)}
          >
            ↻ &nbsp; Refresh
          </button>
        </div>
        {listingError ? (
          <p className="alert" role="alert">
            {listingError}
          </p>
        ) : loading ? (
          <p className="empty" role="status">
            Loading files…
          </p>
        ) : !files.length ? (
          <div className="empty">
            <span aria-hidden="true">▱</span>
            <h3>
              {session?.connected ? "No files in this folder" : "Not connected"}
            </h3>
            <p>
              {session?.connected
                ? `Files uploaded to ${folder || "the root folder"} will appear here.`
                : "Sign in to list files."}
            </p>
          </div>
        ) : (
          <ul className="file-list">
            {files.map((file) => (
              <li key={file.id}>
                <span className="file-symbol" aria-hidden="true">
                  ▤
                </span>
                <a
                  href={`https://app.box.com/file/${encodeURIComponent(file.id)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {file.name}
                </a>
                <span>{bytes(file.size ?? 0)}</span>
                <span aria-hidden="true">↗</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <RequestLog rows={attempts} clear={() => setAttempts([])} />
    </>
  );
}
