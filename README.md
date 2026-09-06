# Box upload test harness

A Next.js test harness with direct browser uploads and an MCP-backed server fallback. Uses chunked uploads from **20 MiB** (Platform apps only), verifies SHA-1 digests, and adds a version when a file name already exists.

## Run

Node 22 LTS or newer.

```sh
npm ci
cp .env.example .env
# Fill in credentials and choose the authentication mode.
npm run dev
```

Open [127.0.0.1:3000](http://127.0.0.1:3000). Both environment files are ignored by Git. Credentials are available to the Next.js server and standalone MCP process; they are never bundled into the browser.

## Authentication

Three separate Box registrations; CCG and authorization code are OAuth grant types, while MCP is a tool protocol.

| App registration       | Grant / identity                                                  | Credential prefix |
| ---------------------- | ----------------------------------------------------------------- | ----------------- |
| Custom MCP integration | Authorization code + PKCE / signed-in user                        | `BOX_MCP_*`       |
| Platform OAuth app     | Authorization code + PKCE / signed-in user                        | `BOX_OAUTH_*`     |
| Platform CCG app       | `client_credentials` / service account or authorized user subject | `BOX_CCG_*`       |

Configure either or both OAuth apps. If the preferred app has no credentials, the other is selected. The UI identifies the active app and offers an explicit reconnect to the alternative. Tokens remain bound to their issuing app; server fallback preserves the same Box user. **The MCP integration supports authorization-code sign-in. CCG uses a separate platform app configured for server authentication.**

For each OAuth app, enable file read/write access and register `${APP_ORIGIN}/api/auth/callback`. For browser uploads, also allow `APP_ORIGIN` in that app’s Box CORS settings. Local defaults:

- Redirect URI: `http://127.0.0.1:3000/api/auth/callback`
- CORS origin: `http://127.0.0.1:3000`

Platform CCG requires [enterprise admin authorization](https://developer.box.com/guides/authentication/client-credentials/client-credentials-setup), no redirect URI, and uses only `BOX_CCG_*` credentials. The [Custom MCP integration](https://developer.box.com/guides/box-mcp/setup) uses its own authorization-code registration. Credentials are never shared between these slots.

## Workbench

MCP OAuth is on the left. On the right, select Platform OAuth or CCG and connect; the selector alone does not change the active session. Any configured option can be connected regardless of the server default. Connecting replaces the previous session; only one app is active. Expand auth configuration for server settings and request paths. **Allow server fallback** can be disabled to test direct access alone. The trace identifies the credential source, actual transport, status, duration, and configuration/fallback reason. Hosted MCP inspection is explicit; it does not move upload bytes through hosted tools.

## Upload behavior

1. MCP prepares the destination and requests a `base_upload` token restricted to that folder. The server verifies Box’s returned restrictions before releasing the token. Broad access tokens, refresh tokens, and client secrets stay on the server.
2. The browser probes Box and sends bytes directly. Large files use three part workers; the server verifies Box’s part list and commits.
3. CORS, DNS, filtering, or timeout failures trigger server fallback. Later files reuse that fallback until the user retries direct access or reconnects. Ordinary Box HTTP errors do **not** trigger fallback.

An interrupted simple upload after bytes were sent has an uncertain outcome: refresh before retrying to avoid duplicate versions. Failed chunk sessions must be aborted before fallback. The activity table shows requests, status, selected app, and transport without credentials or response bodies.

The 20 MiB threshold is this app’s policy; Box supports [direct uploads up to 50 MB](https://developer.box.com/guides/uploads/direct/).

## Other settings

| Variable                   | Default                 | Purpose                                                                                                                 |
| -------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`               | `http://127.0.0.1:3000` | Exact trusted origin; HTTPS required except on loopback.                                                                |
| `BOX_CCG_ROOT_FOLDER_ID`   | `0`                     | CCG destination root.                                                                                                   |
| `BOX_USER_ROOT_FOLDER_ID`  | `0`                     | OAuth destination root; `0` is each signed-in user’s root.                                                              |

## Test and reuse

```sh
npm run typecheck
npm test
npx playwright install chromium
npm run e2e        # Production build + isolated Box simulator + browser tests
npm run e2e:live   # Real CCG MCP uploads; creates test files in the e2e folder
npm run mcp       # Standalone stdio MCP server, always CCG
```

The web app uses request-scoped, in-process MCP connections. `src/mcp/tools.ts` is shared with the standalone server. Box’s separate hosted MCP endpoint is inspected through authenticated `GET /api/connection`; this app’s binary/chunk tools are implemented locally, not claimed as hosted Box tools.

Code: `src/box/` (Box API), `src/auth/` (sessions), `src/mcp/` (tools/transports), `src/app/api/` (HTTP), `src/components/` (UI), `tests/` (security and E2E).

Sessions and direct-upload state are currently in memory; fallback staging is local disk. Restarting signs users out. This is a single-instance app until the [Vercel deployment plan](docs/deployment.md) is implemented. Nothing has been deployed.
