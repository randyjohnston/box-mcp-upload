"use client";
import { useState } from "react";
import type { RequestEvent } from "../request-event";

export type OAuthApp = "mcp" | "platform";
export type AuthApp = OAuthApp | "ccg";
export type AppState = {
  app: AuthApp;
  configured: boolean;
  connected: boolean;
  role?: "primary" | "fallback";
  clientId?: string;
  identity?: { id: string; name: string; login: string };
};
export type SessionInfo = {
  origin: string;
  rootFolderId: string;
  maxUploadBytes: number;
  connected: boolean;
  apps: AppState[];
  primaryApp?: AuthApp;
  fallbackApp?: AuthApp;
  fallbackArmed: boolean;
  defaultApp: AuthApp;
  preferredApp?: OAuthApp;
  mode: "ccg" | "oauth";
  ccg: {
    configured: boolean;
    passwordRequired: boolean;
    subjectType: string;
    subjectId?: string;
  };
  authEvents?: RequestEvent[];
};
export const APP_LABEL: Record<AuthApp, string> = {
  mcp: "MCP integration",
  platform: "Platform OAuth",
  ccg: "Platform CCG",
};
type Tool = { name: string; description?: string; inputSchema?: unknown };

/**
 * Two Box registrations, connected independently.
 *
 * The MCP integration is the path this app prefers. The platform app is a
 * *second* credential you connect at the same time, so that when Box refuses
 * MCP — a permissions error, or a browser blocked by CORS — the fallback is
 * already authorised and no second round of consent is needed.
 *
 * The platform app offers two flows, authorization code and client
 * credentials, which are alternatives: connecting one flow releases the
 * other flow.
 */
export default function AuthWorkbench({
  session,
  busy,
  blocked,
  connect,
  disconnect,
  inspect,
  retry,
}: {
  session?: SessionInfo;
  busy: boolean;
  blocked: boolean;
  connect: (app: AuthApp, password?: string) => void;
  disconnect: () => void;
  inspect: () => Promise<{ connected: boolean; tools: Tool[] }>;
  retry: () => void;
}) {
  const [platformFlow, setPlatformFlow] = useState<"platform" | "ccg">();
  const [password, setPassword] = useState("");
  const [tools, setTools] = useState<Tool[]>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  const state = (app: AuthApp): AppState =>
    session?.apps.find((entry) => entry.app === app) ?? {
      app,
      configured: false,
      connected: false,
    };
  const mcp = state("mcp");
  const platformFlows = [state("platform"), state("ccg")];
  // An explicit pick always wins, so a connected flow can be swapped for the
  // other one. Otherwise show whichever is connected, else the first usable.
  const chosenFlow =
    platformFlows.find((entry) => entry.app === platformFlow && entry.configured)
      ?.app ??
    platformFlows.find((entry) => entry.connected)?.app ??
    platformFlows.find((entry) => entry.configured)?.app;
  const needsPassword = chosenFlow === "ccg" && session?.ccg.passwordRequired;
  const platformConnected = platformFlows.find((entry) => entry.connected);

  return (
    <section className="auth-workbench" aria-labelledby="auth-heading">
      <div className="section-heading">
        <h2 id="auth-heading">Authentication</h2>
        <span
          className="fallback-state"
          data-armed={session?.fallbackArmed ?? false}
        >
          {session?.fallbackArmed
            ? `Retry order: ${APP_LABEL[session.primaryApp!]}, then ${APP_LABEL[session.fallbackApp!]}`
            : session?.connected
              ? `Only ${APP_LABEL[session.primaryApp!]} connected · no retry credential`
              : "Not connected"}
        </span>
      </div>
      <p className="workbench-help">
        Separate Box registrations, with separate CORS rules and scopes.
        Box can refuse one registration and allow the other.
      </p>
      <ol className="policy-rules">
        <li>
          The browser uploads to Box, using the MCP integration first.
        </li>
        <li>
          If Box refuses that credential (<code>401</code>/<code>403</code>),
          or the browser cannot reach Box, the browser retries with the next
          connected credential.
        </li>
        <li>
          If no credential works from the browser, the Next.js server uploads
          the file. Switch that off under Transfer configuration.
        </li>
      </ol>

      <div className="auth-cards">
        <article
          className="auth-card"
          data-connected={mcp.connected}
          data-role="primary"
        >
          <div className="auth-card-head">
            <span className="eyebrow">PRIMARY</span>
            {mcp.connected && (
              <span className="tag" data-active="true">
                connected
              </span>
            )}
          </div>
          <h3>{APP_LABEL.mcp}</h3>
          <p className="auth-card-flow">OAuth · authorization code + PKCE</p>
          {mcp.configured ? (
            <code className="client-id">{mcp.clientId}</code>
          ) : (
            <p className="auth-option-missing">
              Not configured — set <code>BOX_MCP_CLIENT_ID</code> /{" "}
              <code>BOX_MCP_CLIENT_SECRET</code>
            </p>
          )}
          {mcp.identity && (
            <p className="identity">
              <strong>{mcp.identity.name}</strong>
              <span>{mcp.identity.login}</span>
            </p>
          )}
          <button
            className={mcp.connected ? "secondary" : "provider-connect"}
            type="button"
            disabled={busy || checking || !mcp.configured}
            onClick={() => connect("mcp")}
          >
            {mcp.connected ? "Reconnect" : "Connect MCP integration"}
          </button>
        </article>

        <article
          className="auth-card"
          data-connected={Boolean(platformConnected)}
          data-role="fallback"
        >
          <div className="auth-card-head">
            <span className="eyebrow">FALLBACK</span>
            {platformConnected && (
              <span className="tag" data-active="true">
                connected
              </span>
            )}
          </div>
          <h3>Platform app</h3>
          <p className="auth-card-flow">
            Choose one flow — the platform app holds one flow at a time
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (chosenFlow) connect(chosenFlow, password);
              setPassword("");
            }}
          >
            <fieldset className="flow-options" disabled={busy || checking}>
              <legend className="visually-hidden">Platform auth flow</legend>
              {platformFlows.map((entry) => (
                <label
                  className="flow-option"
                  key={entry.app}
                  data-selected={chosenFlow === entry.app}
                  data-configured={entry.configured}
                >
                  <input
                    type="radio"
                    name="platform-flow"
                    value={entry.app}
                    checked={chosenFlow === entry.app}
                    disabled={!entry.configured}
                    onChange={() => {
                      setPlatformFlow(entry.app as "platform" | "ccg");
                      setPassword("");
                    }}
                  />
                  <span>
                    <strong>
                      {entry.app === "ccg"
                        ? "Client credentials (CCG)"
                        : "Authorization code + PKCE"}
                    </strong>
                    {entry.configured ? (
                      <code className="client-id">{entry.clientId}</code>
                    ) : (
                      <span className="auth-option-missing">
                        Not configured —{" "}
                        <code>
                          {entry.app === "ccg" ? "BOX_CCG_*" : "BOX_OAUTH_*"}
                        </code>
                      </span>
                    )}
                    {entry.identity && (
                      <span className="identity">
                        <strong>{entry.identity.name}</strong>
                        <span>{entry.identity.login}</span>
                      </span>
                    )}
                    {entry.app === "ccg" && entry.configured && (
                      <span className="auth-option-note">
                        Service account · {session?.ccg.subjectType}{" "}
                        {session?.ccg.subjectId}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </fieldset>
            {needsPassword && (
              <label className="password-label">
                Access password
                <input
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
            )}
            <button
              className={
                platformConnected?.app === chosenFlow
                  ? "secondary"
                  : "provider-connect"
              }
              disabled={busy || checking || !chosenFlow}
            >
              {platformConnected?.app === chosenFlow
                ? "Reconnect"
                : platformConnected
                  ? `Switch to ${chosenFlow === "ccg" ? "CCG" : "authorization code"}`
                  : "Connect platform app"}
            </button>
          </form>
        </article>
      </div>

      <div className="workbench-actions">
        <button
          className="text-button"
          type="button"
          disabled={!session?.connected || busy || checking}
          onClick={async () => {
            setChecking(true);
            setError("");
            setTools(undefined);
            try {
              setTools((await inspect()).tools);
            } catch (error) {
              setError(
                error instanceof Error
                  ? error.message
                  : "MCP inspection failed.",
              );
            } finally {
              setChecking(false);
            }
          }}
        >
          {checking ? "Inspecting…" : "Inspect hosted MCP tools"}
        </button>
        {blocked && (
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={retry}
          >
            Retry browser upload
          </button>
        )}
        {session?.connected && (
          <button
            className="text-button"
            type="button"
            disabled={busy || checking}
            onClick={disconnect}
          >
            Disconnect all
          </button>
        )}
      </div>

      <details className="config-details">
        <summary>Setup reference</summary>
        <dl className="config-grid">
          <div>
            <dt>Callback URL (MCP integration and platform OAuth)</dt>
            <dd>
              <code>{session?.origin ?? ""}/api/auth/callback</code>
            </dd>
          </div>
          <div>
            <dt>CORS origin for browser uploads to Box</dt>
            <dd>
              <code>{session?.origin ?? ""}</code>
            </dd>
          </div>
        </dl>
        <p>
          Credentials live in <code>.env</code>. Environment variables only set
          which app is connected by default; anything configured can be
          connected here.
        </p>
      </details>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {tools && (
        <div className="tool-inspection">
          <strong>Hosted MCP · {tools.length} relevant tools</strong>
          {!tools.length && (
            <p>No matching upload or identity tools were advertised.</p>
          )}
          {tools.map((tool) => (
            <details key={tool.name}>
              <summary>{tool.name}</summary>
              <p>{tool.description}</p>
              <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
