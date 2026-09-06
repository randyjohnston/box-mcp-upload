# Vercel deployment plan — not deployed

The current app needs changes before multi-instance hosting. Do not deploy it unchanged.

## Target design

- Vercel hosts Next.js, OAuth callbacks, session validation, and upload control requests.
- Keep browser-to-Box uploads as the default. Only verified folder-restricted `base_upload` tokens or validated hosted MCP upload tickets reach the browser.
- Replace in-memory sessions, OAuth state, and direct-upload records with a shared database. Encrypt stored Box tokens; use transactions/locks for single-use state, refresh-token rotation, and commit ownership. Add expiry cleanup.
- Replace temporary files on the Next.js server with access-controlled object storage and an upload worker. For browser-blocked Box traffic, send small chunks to the application origin, reassemble in storage, and queue the MCP-backed Box transfer. Return a job ID and poll progress; a repeated retry must not create a second file.
- Package the shared MCP tools in the worker or run an authenticated remote MCP service. Do not spawn `npx`/stdio child processes from Vercel functions.

Vercel functions have a [4.5 MB request/response payload limit](https://vercel.com/docs/functions/limitations). Streaming a large body through the existing staging route does not remove that limit. Keep fallback request chunks below 4 MB including overhead; alternatively use browser-to-private-storage uploads when its domain is allowed. Check plan-specific duration/memory limits when provisioning the worker.

## Configuration

The first configured app in MCP → Platform OAuth → CCG order sets the initial UI default. Only provision credentials for flows the deployment should expose; users can explicitly connect any configured app.

Set server-only variables separately for Preview and Production; never prefix secrets with `NEXT_PUBLIC_`.

| Deployment                   | Variables                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| OAuth, MCP preferred         | `BOX_MCP_CLIENT_ID`, `BOX_MCP_CLIENT_SECRET`                                                                                        |
| OAuth, platform preferred    | `BOX_OAUTH_CLIENT_ID`, `BOX_OAUTH_CLIENT_SECRET`                                                                                    |
| Optional alternate OAuth app | Configure the other credential pair; MCP and one Platform credential can coexist. Cross-account fallback is allowed in the harness. |
| CCG                          | `BOX_CCG_CLIENT_ID`, `BOX_CCG_CLIENT_SECRET`, `BOX_CCG_ENTERPRISE_ID` or `BOX_CCG_USER_ID`, `BOX_CCG_ROOT_FOLDER_ID`                |
| Shared                       | `APP_ORIGIN`, `BOX_USER_ROOT_FOLDER_ID`, `MAX_UPLOAD_BYTES`, plus future database, encryption-key, storage, and queue settings      |

Use stable HTTPS domains and register each exact callback and CORS origin in Box. Prefer a fixed preview domain and a separate Box test app over wildcard preview authorization. Scope apps to required content permissions. Put CCG behind enterprise SSO and role checks; a shared password is only a temporary gate. Add per-user quotas, distributed rate limits, audit events, and monitoring without tokens, cookies, or authorization codes.

## Release sequence

1. Implement shared storage/locking and the fallback upload worker; test across multiple instances and restarts.
2. Run security/unit/browser tests and live Box tests for CCG and both OAuth credential sources. Verify downscoping denies another folder and downloads; verify PKCE rejects an incorrect verifier.
3. Deploy a private preview, test direct and blocked-browser paths above 20 MiB, refresh rotation, expiry, disconnects, and duplicate commits.
4. Configure Production secrets and domain, verify callback/CORS settings, then request deployment approval. Keep the previous release available for rollback.
