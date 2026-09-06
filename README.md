# Box upload test harness

A browser workbench for testing **Box-hosted MCP**, **Platform authorization code + PKCE**, and **Platform client credentials (CCG)**. Connect apps, upload files, and inspect the actual requests and credential source. This is a developer harness, with sessions stored in the Next.js process and temporary upload files on the computer running this app.

[Architecture diagram](docs/diagrams/architecture.html) · [Fallback workflow](#fallback-and-uncertain-results) · [Possible simplifications](docs/simplification-candidates.md)

The diagram is standalone interactive HTML generated with Archify. Download/open it in a browser; GitHub's file viewer shows its source. Its editable JSON specification lives beside it.

## Run

Node 22 LTS or newer.

```sh
npm ci
cp .env.example .env
# Fill in at least one credential pair and the CCG subject if using CCG.
npm run dev
```

Open [127.0.0.1:3000](http://127.0.0.1:3000). Next.js and the standalone MCP process read `.env`; it is ignored by Git. Never prefix credentials with `NEXT_PUBLIC_`.

## Connect the three flows

| Registration           | Identity / grant                                             | Required variables                                                                             |
| ---------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Custom MCP integration | Signed-in user; authorization code + PKCE                    | `BOX_MCP_CLIENT_ID`, `BOX_MCP_CLIENT_SECRET`                                                   |
| Platform OAuth app     | Signed-in user; authorization code + PKCE                    | `BOX_OAUTH_CLIENT_ID`, `BOX_OAUTH_CLIENT_SECRET`                                               |
| Platform CCG app       | Service account, or an authorized user; `client_credentials` | `BOX_CCG_CLIENT_ID`, `BOX_CCG_CLIENT_SECRET`, and `BOX_CCG_ENTERPRISE_ID` or `BOX_CCG_USER_ID` |

Use separate registrations and credentials for these flows. The [Box MCP setup guide](https://developer.box.com/guides/box-mcp/setup) covers the MCP integration; [CCG setup](https://developer.box.com/guides/authentication/client-credentials/client-credentials-setup) requires enterprise authorization. A non-empty `BOX_CCG_USER_ID` selects a user subject; otherwise the enterprise ID selects its service account.

For each authorization-code registration, enable the required file read/write access and register:

- Callback: `http://127.0.0.1:3000/api/auth/callback`
- CORS origin: `http://127.0.0.1:3000`

For direct browser uploads, configure the CORS origin on each participating Box app, including the CCG app. CCG does not use a callback. If you change `APP_ORIGIN`, update the registered callback and CORS origin to match exactly.

The first configured app in **MCP → Platform OAuth → CCG** order is the default. There is no default-app environment variable. Connecting MCP and a Platform app retains both credentials. MCP takes precedence; the other connected credential is available for retry. Platform OAuth and CCG replace one another. Selecting a radio button alone does not connect or change the session. **Disconnect all** clears the session.

**Cross-account fallback is intentional in this harness.** The alternate credential may use another Box account or root. Transfers show the actual account/root and an **Open saved file** link. The file library lists the primary account only. Disconnect all and connect the desired app alone to isolate a flow.

## Upload routes

An **upload ticket** is the URL and upload token returned by Box’s `get_upload_url` tool. **Inline text** means file contents sent as a string in an MCP tool call.

Every upload starts with a server control request. Full OAuth tokens, refresh tokens and client secrets stay on the server.

| Credential / file                            | Preparation                                                                       | File bytes                                                                                                                    | Finalization                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| MCP: supported text extension, up to 256 KiB | The app’s MCP tools select the server route                                       | Saved to a temporary file on the server, then sent inline with hosted `upload_file` / `upload_file_version` if lossless UTF-8 | Hosted tool result                                                                 |
| MCP: other files                             | Hosted `get_upload_url`; validate the URL and require its upload token            | Browser multipart POST with that ticket                                                                                       | Box upload response                                                                |
| Platform OAuth or CCG: below 20 MiB          | Resolve folder, verify folder-restricted `base_upload` token, check name conflict | Browser multipart POST                                                                                                        | Box upload response                                                                |
| Platform OAuth or CCG: 20 MiB and above      | Same downscoping plus a Box upload session                                        | Browser SHA-1 hashing and three part workers                                                                                  | Server lists parts, checks coverage, commits with whole-file SHA-1                 |
| Server fallback                              | Save a temporary file on the server; allow one upload attempt to use it           | The app’s MCP tools use hosted MCP for MCP credentials, or Platform REST for OAuth/CCG                                        | Result and request/progress events streamed to the browser; temporary file deleted |

### File size limits

Each path has two ceilings: this harness's own limit, then Box's. The harness rejects any file above `MAX_UPLOAD_BYTES` (default 512 MiB) before it makes a Box call; the Box account limit applies after that.

| Path | Harness behavior | Box limit |
| --- | --- | --- |
| MCP · inline text (`upload_file`, `upload_file_version`) | Used for a supported text extension up to 256 KiB, UTF-8 only. Larger or non-UTF-8 files use the binary ticket instead. | Box publishes no size limit for these tools. Box's own tests of base64 text sent *through an AI model* show a corrupted file near 175 KB and outright failure at 20 MB. This harness sends the text directly from the server, not through a model, so that corruption does not apply; the 256 KiB cap is a payload-size choice. |
| MCP · binary ticket (`get_upload_url`) | One HTTP POST of the whole file to the returned URL. | Box publishes no size limit for `get_upload_url`. **Verified against Box's live MCP server:** it returns a single POST URL on the simple-upload endpoint (`upload.app.box.com/api/2.0/files/content`, with a bound `upload_token`), identical in shape for a 1&nbsp;KB and a 100&nbsp;MB request. This is `multipart/form-data` — one request — not a chunked/session upload (`/files/upload_sessions/…`); Box's MCP server publishes no part, commit, or session tool. The URL and token are single-use and expire after about 10 minutes. |
| Platform simple (`POST /files/content`) | Used below 20 MiB. | Up to 50 MB per the API reference; Box recommends chunked upload above 50 MB. |
| Platform chunked (upload session) | Used at 20 MiB and above, in 8 MiB parts across three workers. | Minimum 20 MB (20,000,000 bytes). Maximum is the account limit — up to 500 GB on Enterprise Advanced (Jan 2025), previously 150 GB. |

The harness switches to a chunked session at 20 MiB (20,971,520 bytes), which is above Box's 20 MB (20,000,000-byte) session minimum, so any file routed to a session is always large enough to create one.

**Box does not publish explicit size limits for the two MCP upload tools.** The MCP figures above are the only numbers Box states, and they describe base64 behavior through an AI model, not a limit of the tool itself. Box's [published MCP tools](https://developer.box.com/guides/box-mcp/tools) are separate from the MCP tools that run inside this app.

Two conditions gate the MCP binary path regardless of file size:

- `get_upload_url` (and `get_download_url`) are **off by default** on the Box MCP server. An enterprise admin enables them under Admin Console → Integrations → Box MCP Server → Files and Folders → Custom Configuration. Until then, the path fails.
- Some clients require allowlisting the upload hosts: `upload.*.box.com`, `*.boxcloud.com`, and `*.box.com`.

Sources: [direct upload](https://developer.box.com/guides/uploads/direct/), [`POST /files/content` reference](https://developer.box.com/reference/post-files-content/), [chunked upload](https://developer.box.com/guides/uploads/chunked/), [binary over MCP](https://blog.box.com/upload-and-download-binary-mcp-how-box-solved-last-mile-agentic-file-editing), [500 GB limit (Jan 2025)](https://support.box.com/hc/en-us/articles/37322112876307-Large-file-size-limit-for-uploads-and-downloads-Jan-2025).

Inline extensions: `txt`, `md`, `boxnote`, `html`, `svg`, `xml`, `csv`, `json`, `js`, `ts`, `py`, `sh`. Non-UTF-8 content uses the binary ticket route from the server, preserving bytes and BOMs. Matching file names add a new version; hosted folder lookup follows pagination and only resolves immediate children of the configured root.

## Fallback and uncertain results

“Staging” means saving the browser's bytes to a temporary file on the computer running this app, before sending them to Box. Platform chunked uploads read these files a piece at a time. The MCP binary server route currently reads the entire temporary file into memory before posting it to Box, so large MCP fallback uploads can still use substantial memory. Direct browser-to-Box uploads skip this step.

1. Try the primary credential, then the other connected credential after a safe failure: an explicit 401/403 refusal, or a failed chunk transfer whose session was successfully aborted.
2. Refused/blocked credentials are skipped for later files in this tab until **Retry browser upload** or reconnection.
3. If the eligible browser attempts fail, **Let the Next.js server carry file bytes** permits temporary files and server upload. This setting also controls MCP inline text: turning it off stops that route before sending bytes to this server.
4. A lost simple POST response, timeout, or 5xx may follow a successful write. The harness reports an **uncertain outcome** and does not retry automatically. Failed/ambiguous commits and failed chunk aborts also stop. Inspect the destination before selecting the file again. Other HTTP errors stop rather than changing credentials.

Disabling server bytes does not disable server control requests such as token exchange, folder lookup, or chunk commit. A network failure during a simple POST cannot be distinguished from a rejected CORS preflight, so it also stops for review; use chunked files or explicit HTTP refusals to exercise safe automatic fallback.

## Debugging

The request trace identifies the app, transport, operation, status, duration and reason. Expand requests to distinguish **Browser → Box**, **Next.js server → Box-hosted MCP**, **Next.js server → Box REST**, and **MCP tools in the Next.js process**. Server trace events exclude headers, bodies, cookies and URL query strings. The browser retains the latest 120 rows in session storage for the current browser tab; use Clear to reset them.

| Symptom                              | Check                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| No connection / token failure        | Matching registration credentials; CCG enterprise authorization and subject; callback URL                           |
| `403 cors_origin_not_whitelisted`    | CORS origin on the app named in the trace                                                                           |
| Opaque network failure / timeout     | Browser Network tab, CORS, filtering, and the destination before retrying an uncertain write                        |
| Saved file absent from library       | Transfer's account/root and saved-file link; fallback may have used another account                                 |
| MCP ticket rejected                  | Hosted `get_upload_url` result must contain a trusted URL and upload token; full OAuth tokens are never substituted |
| MCP text stops with server bytes off | Enable the setting, or connect a Platform app alone for direct upload                                               |

**Inspect hosted MCP** explicitly lists published tools using the primary credential. Upload operations with the MCP registration also call the hosted server; inspection is not the only hosted path. Sign-in resolves identity through the Box REST API for all registrations.

## Settings and limits

| Variable                  | Default                             | Purpose                                                                                                         |
| ------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`              | `http://127.0.0.1:3000`             | Exact trusted origin; HTTPS required except on loopback                                                         |
| `BOX_USER_ROOT_FOLDER_ID` | `0`                                 | Root used by both authorization-code registrations                                                              |
| `BOX_CCG_ROOT_FOLDER_ID`  | `0`                                 | CCG destination root                                                                                            |
| `APP_ACCESS_PASSWORD`     | Unset                               | Optional CCG password when accessed on the same computer; at least 16 characters required for remote CCG access |
| `MAX_UPLOAD_BYTES`        | `536870912` (512 MiB)               | Per-file web upload limit                                                                                       |
| `STAGING_DIR`             | `.staging` in the working directory | Temporary fallback/inline files on this server                                                                  |

Sessions expire eight hours after connection; pending OAuth state lasts ten minutes. Restarting signs users out. Direct chunk records last 15 minutes. Temporary files are removed after an upload attempt; abandoned files are swept after six hours when the server receives another file. Browser Box requests time out after 60 seconds. Uploads are queued in the UI, with at most 20 pending files.

The current implementation is single-instance. The [deployment document](docs/deployment.md) records limitations and optional future work; it is not required to run this harness and no deployment is part of this project setup.

## Verify and reuse

```sh
npm run typecheck
npm test
npm run format:check
npx playwright install chromium
npm run e2e        # Production build + Box REST/MCP simulator on this computer + Chromium
npm run e2e:live   # Real CCG uploads through this app’s separate MCP server; writes into e2e/
npm run mcp       # Standalone stdio MCP server, always CCG
```

The browser suite explicitly supplies test credentials and endpoints for MCP, Platform OAuth and CCG; it never uses live `.env` credentials. It covers direct/server uploads, hashes and versions, paging, text encoding, credential retry (including different accounts), uncertain writes, auth refresh, CSRF, and ownership. Simulator coverage does not establish compatibility with a live hosted Box service; verify registration-specific permissions and tool behavior in the workbench.

The web app creates a request-scoped in-process MCP connection. `src/mcp/tools.ts` also backs the standalone stdio entry point. This separate server has no tool for receiving file bytes: `scripts/e2e.ts` first saves a temporary file on the same computer, then passes its upload ID to the server. `e2e:live` tests CCG via this app’s separate MCP server, not Box-hosted MCP.

Code: `src/box/` (Platform API), `src/auth/` (sessions), `src/mcp/` (app MCP tools and connection to Box-hosted MCP), `src/app/api/` (HTTP), `src/components/` (workbench), `tests/` (regressions and simulator).
