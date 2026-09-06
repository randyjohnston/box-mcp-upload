# Architecture and upload limits

The Next.js server holds Box credentials and prepares uploads. The browser normally sends file bytes directly to Box. Server uploads first save a temporary file on the computer running Next.js.

<p align="center">
  <img src="diagrams/architecture.png" alt="Box upload components and fallback workflow" width="100%">
</p>

Download and open [the interactive diagram](diagrams/architecture.html) for zoom, theme selection, and path tracing. Its source is [architecture.json](diagrams/architecture.json); the [delivery receipt](diagrams/architecture.receipt.json) records validation and file hashes.

## Components and credentials

| Component               | Responsibility                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser workbench       | Queue files, hash parts, upload bytes, and display request traces.                                                                                     |
| Next.js API             | Check the request origin and session, receive temporary files, and call the app's MCP tools.                                                           |
| App MCP tools           | Functions connected by the MCP SDK inside the Next.js process. Dispatch to Box-hosted MCP or Platform REST.                                            |
| Session and OAuth state | Hold client credentials, access/refresh tokens, OAuth state, and PKCE data in server memory.                                                           |
| Box-hosted MCP          | Folder lookup, inline text uploads, and upload tickets for the MCP registration.                                                                       |
| Box Platform API        | Folder lookup, token downscoping, and upload-session control for Platform OAuth and CCG. Also resolves identity during sign-in for every registration. |
| Box upload hosts        | Receive file bytes using a scoped token or MCP upload ticket.                                                                                          |
| Temporary upload files  | Store bytes for a server upload attempt, then delete them.                                                                                             |

Full tokens and client secrets stay on the Next.js server. The browser receives a folder-restricted `base_upload` token for Platform uploads, or the URL and upload token returned by hosted `get_upload_url`. The server validates the upload host and rejects missing tokens or a token equal to its full credential.

MCP and one Platform credential can connect together. MCP takes priority; Platform OAuth and CCG are mutually exclusive. The configured default is the first available of MCP, Platform OAuth, then CCG. Cross-account fallback is allowed, so the transfer result names the account and root actually used.

## Upload routes

- **MCP inline text:** for a supported extension up to 256 KiB, the server saves the file, checks lossless UTF-8 decoding, then calls `upload_file` or `upload_file_version`. Invalid UTF-8 uses a hosted upload ticket from the server instead. Byte-order marks are preserved.
- **MCP binary:** `get_upload_url` prepares one `multipart/form-data` POST. The browser sends the entire file to that URL. Here, “multipart” means one HTTP body containing metadata and file content; it does not mean independently uploaded chunks.
- **Platform simple:** below 20 MiB, the server resolves the folder, obtains a folder-restricted token, and checks for a name conflict. The browser POSTs a new file or version.
- **Platform chunked:** at 20 MiB or above, the server creates an upload session. The browser uses the returned `part_size`, hashes with SHA-1, and sends parts with three workers. The server lists parts, verifies coverage, and commits with the whole-file digest. Part size is not fixed at 8 MiB.
- **Server upload:** after saving a temporary file, the app calls the same MCP or Platform implementation with the selected credential and streams progress to the browser. Platform chunked uploads read one part at a time; Platform simple and MCP binary uploads read the entire temporary file into memory.

Matching file names add versions. Folder lookup resolves only immediate children of the configured root. Hosted listing follows the returned pagination metadata and reports an error on repeated or incomplete pages. The simulator tests offset pagination; verify the live tool's accepted arguments using **Inspect hosted MCP**.

Inline extensions: `txt`, `md`, `boxnote`, `html`, `svg`, `xml`, `csv`, `json`, `js`, `ts`, `py`, `sh`.

## Fallback workflow

1. Try the primary credential, then the second connected credential after an explicit 401/403 refusal or a network failure during a chunked upload whose session was successfully aborted.
2. Skip that credential for later files in the tab until **Retry browser upload** or reconnection.
3. If no eligible browser route succeeds, use a server upload when **Let the Next.js server carry file bytes** is enabled. The server uses the primary credential, except that a primary refusal in this attempt selects the connected fallback credential. This setting also controls MCP inline text.
4. Stop on an uncertain POST result, failed commit, failed abort, or other HTTP error. A write may have succeeded even when its response was lost. Inspect Box before uploading the file again.

A browser cannot distinguish a rejected CORS preflight from a connection lost after a successful POST. Automatic fallback therefore cannot safely follow an opaque simple-upload error. Chunk uploads must abort successfully before a retry can use another credential.

## File size limits

Sources checked on **2026-09-06**. KiB and MiB use powers of 1024; Box's MB and GB labels are reproduced as published.

| Route             | Harness setting                                                                                           | Published Box constraint                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All web uploads   | Non-empty files, at most `MAX_UPLOAD_BYTES`; default 512 MiB.                                             | Account maximum also applies. Check **Account Settings → Account Details → Max File Size**.                                                                |
| MCP inline text   | Supported extension, at most 256 KiB, lossless UTF-8.                                                     | The cited MCP documentation publishes no numeric payload limit for `upload_file` or `upload_file_version`.                                                 |
| MCP binary ticket | One POST; no part retries or resume.                                                                      | No numeric maximum is published for `get_upload_url` in the cited documentation. Ticket creation alone does not prove a file of that size can be uploaded. |
| Platform simple   | Selected below 20 MiB.                                                                                    | Box recommends chunked upload above 50 MB; this is a recommendation, not a documented 50 MB hard cap.                                                      |
| Platform chunked  | Selected at 20 MiB (20,971,520 bytes). Uses Box's part size; rejects invalid sizes or parts above 64 MiB. | Minimum file size is 20 MB. Box documents a seven-day session lifetime; the harness retains its browser-upload record for only 15 minutes.                 |

Box lists account maxima from 250 MB for Free Personal to 500 GB for Enterprise Advanced. The configured harness maximum is separate and is not automatically adjusted to the account. See [direct uploads](https://developer.box.com/guides/uploads/direct), [upload API](https://developer.box.com/reference/post-files-content), and [chunked uploads](https://developer.box.com/guides/uploads/chunked).

Box's [binary-over-MCP article](https://blog.box.com/upload-and-download-binary-mcp-how-box-solved-last-mile-agentic-file-editing) compares passing base64 through a model with transferring bytes through a temporary URL. Its benchmark failures are not MCP tool size limits. This harness sends text programmatically and never passes file contents through a model.

### MCP tool access and evidence limits

Box's [published tools](https://developer.box.com/guides/box-mcp/tools) lists `get_upload_url` and `upload_file_version` as off by default; an enterprise admin must enable the tools needed for the test. Network filtering may also require Box's upload domains to be allowed. This is separate from an app's browser CORS configuration.

Earlier manual testing recorded `get_upload_url` responses for declared sizes of 1 KB and 100 MB. Both targeted `upload.app.box.com/api/2.0/files/content` with an upload token. That shows the same endpoint shape, not successful transfer at those sizes. No retained test establishes the maximum MCP file size. An `upload_session_id` query parameter on this URL is not evidence of the Platform chunked-upload protocol.

Earlier notes reported ticket expiry of about ten minutes. The cited public pages promise short-lived, single-use URLs without a numeric lifetime, so ten minutes remains an observation to recheck in the live tool description. Expiry alone does not establish whether Box terminates a transfer already in progress.

Earlier testing also reported different CORS behavior between simple and chunked endpoints. Treat this as registration-specific evidence, not a guarantee that chunked uploads bypass CORS. Configure the origin for every app and use the request trace to compare failures.

## Timeouts and capacity

| Setting                                    | Current value and scope                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser request to Box                     | 60 seconds per request, including an entire simple upload.                                                                                      |
| Server Box REST or hosted MCP HTTP request | 60 seconds per attempt.                                                                                                                         |
| MCP binary POST from the server            | 15 minutes.                                                                                                                                     |
| App MCP tool call / browser commit request | 15 minutes / 16 minutes.                                                                                                                        |
| Browser transfer to temporary storage      | 10 minutes.                                                                                                                                     |
| Session / pending OAuth state              | 8 hours / 10 minutes. Restarting Next.js clears both.                                                                                           |
| Pending browser chunk sessions             | 15 minutes; at most 5 per owner and 1,000 per process.                                                                                          |
| Browser queue / displayed trace            | At most 20 pending files / 120 rows in the tab's session storage.                                                                               |
| Temporary storage                          | At most 3 concurrent incoming uploads. Admission stops at 100 existing files or 2 GiB already stored; in-flight writes can exceed those totals. |
| Abandoned temporary files                  | Expire after 6 hours; cleanup runs when another file arrives. Claimed uploads delete their files after the attempt.                             |

Chunk workers retry 429/5xx responses up to three times, with delays capped at 30 seconds. Server REST retries eligible reads, part PUTs, and deletes; it does not replay a POST after a network failure or 5xx. A commit returning 202 is polled up to ten times. These are harness policies, not Box service limits.

## Source layout

| Directory                         | Contents                                                     |
| --------------------------------- | ------------------------------------------------------------ |
| `src/auth/`, `src/box/`           | Sessions, grants, Platform REST, folders, and uploads.       |
| `src/mcp/`                        | App MCP tools, Box-hosted MCP client, and stdio entry point. |
| `src/app/api/`, `src/components/` | HTTP routes and browser workbench.                           |
| `tests/`                          | Unit regressions, Box simulator, and browser tests.          |

`npm run mcp` starts this project's stdio server with CCG. It has no byte-receiving tool: an external caller must first save a temporary file on the computer running that server and pass its upload ID. `scripts/e2e.ts` does this for `npm run e2e:live`, which writes real Box files under `e2e/`. This tests the project's MCP wrapper, not the Box-hosted MCP service.

The web app creates an MCP SDK client/server pair for each request. This wrapper, the standalone runner, and other optional features are listed in [simplification candidates](simplification-candidates.md). They have not been removed.
