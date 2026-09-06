import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BoxClient } from "../box/client";
import {
  assertSafeName,
  listFolder,
  resolveFolder,
  whoAmI,
} from "../box/folders";
import { uploadFile, type UploadProgress } from "../box/upload";
import { claimUpload, discardUpload } from "../staging";
import { prepareDirect, finishDirect } from "../box/direct";
import type { TokenProvider } from "../box/auth";
import type { AuthApp } from "../box/config";
import { HttpError, publicError } from "../errors";
import {
  hostedFindFile,
  hostedListFolder,
  hostedPostBytes,
  hostedResolveFolder,
  hostedUploadText,
  hostedUploadUrl,
  hostedWhoAmI,
  isSmallText,
  decodeInlineText,
} from "./hosted";
import { AUTH_APP_LABEL } from "../box/config";
import { readFile } from "node:fs/promises";

export function createBoxServer(
  client: BoxClient,
  owner = "mcp",
  auth?: TokenProvider,
  app?: AuthApp,
) {
  const server = new McpServer({ name: "box-upload", version: "0.2.0" });
  const folder = z.string().max(255).optional();
  // The MCP application is only a genuine MCP test if the work is done by
  // Box's own published tools. For that credential every operation below is
  // routed to mcp.box.com; the OAuth and CCG credentials use the REST API.
  const viaHostedMcp = app === "mcp" && Boolean(auth);
  const hostedRoot = () => client.rootFolderId;
  async function reply(action: () => Promise<Record<string, unknown>>) {
    try {
      const value = await action();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        structuredContent: value,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: publicError(error) }],
        structuredContent: {
          error: publicError(error),
          status: error instanceof HttpError ? error.status : 502,
        },
      };
    }
  }
  server.registerTool(
    "box_whoami",
    {
      description: "Identify the connected Box account.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => reply(() => (viaHostedMcp ? hostedWhoAmI(auth!) : whoAmI(client))),
  );
  server.registerTool(
    "box_list_folder",
    {
      description:
        "List a folder beneath the configured root without creating it.",
      inputSchema: { folder },
      annotations: { readOnlyHint: true },
    },
    ({ folder }) =>
      reply(async () => {
        if (viaHostedMcp) {
          const folderId = await hostedResolveFolder(
            auth!,
            hostedRoot(),
            folder,
          );
          return {
            folderId,
            items: folderId ? await hostedListFolder(auth!, folderId) : [],
          };
        }
        const folderId = await resolveFolder(client, folder);
        return {
          folderId,
          items: folderId ? await listFolder(client, folderId) : [],
        };
      }),
  );
  server.registerTool(
    "box_upload_file",
    {
      description:
        "Upload a staged file under the configured root. Matching names add a new version. Staged bytes are removed after the attempt.",
      inputSchema: { uploadId: z.string().uuid(), folder },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    ({ uploadId, folder }, extra) =>
      reply(async () => {
        const { filePath, meta } = await claimUpload(uploadId, owner);
        try {
          if (viaHostedMcp) {
            // Small text goes up inline with one tool call; anything else uses
            // get_upload_url, which is Box's documented binary path.
            const folderId = (await hostedResolveFolder(
              auth!,
              hostedRoot(),
              folder,
              true,
            ))!;
            const existing = await hostedFindFile(
              auth!,
              folderId,
              meta.fileName,
            );
            const text = isSmallText(meta.fileName, meta.size)
              ? decodeInlineText(await readFile(filePath))
              : undefined;
            if (text !== undefined) {
              const uploaded = await hostedUploadText(auth!, {
                fileName: meta.fileName,
                content: text,
                parentFolderId: folderId,
                fileId: existing?.id,
              });
              return {
                id: uploaded.file_id,
                name: uploaded.file_name ?? meta.fileName,
                size: meta.size,
                strategy: existing
                  ? "mcp upload_file_version"
                  : "mcp upload_file",
                newVersion: Boolean(existing),
                folderId,
              };
            }
            const ticket = await hostedUploadUrl(auth!, {
              fileName: meta.fileName,
              fileSizeBytes: meta.size,
              parentFolderId: folderId,
              fileId: existing?.id,
            });
            const entry = await hostedPostBytes({
              uploadUrl: ticket.upload_url,
              uploadToken: ticket.upload_token,
              fileName: meta.fileName,
              parentFolderId: existing ? undefined : folderId,
              bytes: new Uint8Array(await readFile(filePath)),
              credential: auth!.app ? AUTH_APP_LABEL[auth!.app] : undefined,
            });
            return {
              id: entry.id,
              name: entry.name,
              size: meta.size,
              strategy: "mcp get_upload_url",
              newVersion: Boolean(existing),
              folderId,
            };
          }
          const folderId = (await resolveFolder(client, folder, true))!;
          const progressToken = extra._meta?.progressToken;
          const onProgress =
            progressToken === undefined
              ? undefined
              : (p: UploadProgress) => {
                  void extra
                    .sendNotification({
                      method: "notifications/progress",
                      params: {
                        progressToken,
                        progress: p.bytesUploaded,
                        total: p.totalBytes,
                        message: p.phase,
                      },
                    })
                    .catch(() => undefined);
                };
          return {
            ...(await uploadFile(client, {
              filePath,
              fileName: meta.fileName,
              folderId,
              onProgress,
            })),
            folderId,
          };
        } finally {
          await discardUpload(uploadId);
        }
      }),
  );
  if (auth) {
    server.registerTool(
      "box_prepare_upload",
      {
        description:
          "Prepare a direct browser upload with a folder-restricted token.",
        inputSchema: {
          name: z.string().max(255),
          size: z.number().int().positive(),
          folder,
        },
      },
      ({ name, size, folder }) =>
        reply(async () => {
          name = assertSafeName(name, "file");
          if (!viaHostedMcp)
            return prepareDirect(client, auth, owner, name, size, folder, app);
          // Box's MCP surface has no upload session: get_upload_url returns a
          // single-use URL and token for one multipart POST, which is exactly
          // the shape the browser's simple-upload path already sends.
          const folderId = (await hostedResolveFolder(
            auth!,
            hostedRoot(),
            folder,
            true,
          ))!;
          // Small text is Box's inline case: one upload_file call, no binary
          // transfer at all. The browser cannot make that call (it holds no
          // credential), so it is told to route via the Next.js server. This
          // is a chosen route, not a fallback.
          if (isSmallText(name, size))
            return {
              strategy: "server-inline" as const,
              via: "box mcp upload_file",
              name,
              size,
            };
          const existing = await hostedFindFile(auth!, folderId, name);
          const ticket = await hostedUploadUrl(auth!, {
            fileName: name,
            fileSizeBytes: size,
            parentFolderId: folderId,
            fileId: existing?.id,
          });
          return {
            strategy: "simple" as const,
            uploadUrl: ticket.upload_url,
            token: ticket.upload_token,
            folderId: existing ? "" : folderId,
            name,
            size,
            newVersion: Boolean(existing),
            via: "box mcp get_upload_url",
          };
        }),
    );
    server.registerTool(
      "box_finish_upload",
      {
        description:
          "Commit verified direct-upload parts, or abort when digest is omitted.",
        inputSchema: {
          id: z.string().uuid(),
          digest: z
            .string()
            .regex(/^[A-Za-z0-9+/]{27}=$/)
            .optional(),
        },
      },
      ({ id, digest }) => reply(() => finishDirect(client, owner, id, digest)),
    );
  }
  return server;
}
