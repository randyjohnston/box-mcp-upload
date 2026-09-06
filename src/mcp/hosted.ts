import { HttpError } from "../errors";
import { tracedFetch } from "../telemetry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AUTH_APP_LABEL } from "../box/config";
import type { TokenProvider } from "../box/auth";

const HOSTED_MCP = "https://mcp.box.com";

/**
 * Box's own MCP server.
 *
 * This is the only module that speaks to it, and it uses nothing but the tools
 * Box publishes there. That is the point: authenticating with the MCP
 * application and then calling the REST API would be the platform OAuth flow
 * wearing a different client ID, not a test of MCP.
 *
 * Box's published upload tools:
 *   upload_file          text content only, single call, new file
 *   upload_file_version  text content only, single call, existing file
 *   get_upload_url       binary or large files: returns a single-use
 *                        upload_url (+ upload_token) to POST multipart bytes to
 *
 * Note there is no chunked upload-session tool. "multipart" in Box's
 * `get_upload_url` description means the multipart/form-data encoding of a
 * single POST, not a chunked upload: the tool returns one URL and one token,
 * with no part size, part count, commit endpoint or resume. A binary file
 * therefore goes up in exactly one request.
 */
export type HostedTool =
  | "who_am_i"
  | "get_upload_url"
  | "upload_file"
  | "upload_file_version"
  | "list_folder_content_by_folder_id"
  | "search_folders_by_name"
  | "create_folder";

const PUBLISHED: HostedTool[] = [
  "who_am_i",
  "get_upload_url",
  "upload_file",
  "upload_file_version",
  "list_folder_content_by_folder_id",
  "search_folders_by_name",
  "create_folder",
];

export type BoxEntry = {
  type: string;
  id: string;
  name: string;
  size?: number;
  modified_at?: string;
};

/**
 * Box's tools disagree on shape: `list_folder_content_by_folder_id` returns
 * `{entries:[{type,…}]}`, while `search_folders_by_name` returns a bare array
 * of `{entryType,…}`. Normalise both before anything downstream reads them.
 */
function entriesOf(value: unknown): BoxEntry[] {
  const raw = Array.isArray(value)
    ? value
    : Array.isArray((value as { entries?: unknown })?.entries)
      ? ((value as { entries: unknown[] }).entries as unknown[])
      : [];
  return raw.map((item) => {
    const entry = item as BoxEntry & { entryType?: string };
    return { ...entry, type: entry.type ?? entry.entryType ?? "" };
  });
}

/** What each Box MCP tool is being called to accomplish. */
const TOOL_PURPOSE: Record<string, string> = {
  who_am_i: "identify which Box account this credential authenticates as",
  search_folders_by_name:
    "find the destination folder by name when it was not in the listing",
  create_folder: "create the destination folder because it does not exist yet",
  list_folder_content_by_folder_id:
    "read the destination folder: its contents, and whether the file already exists",
  get_upload_url:
    "obtain a single-use URL and token to POST the file bytes to",
  upload_file: "upload a small text file inline, in this one call",
  upload_file_version:
    "replace an existing file's contents inline, in this one call",
};

/** Why a given JSON-RPC message is being sent to Box's MCP server. */
function purpose(method: string, tool?: string): string {
  if (method === "initialize")
    return "MCP handshake: agree a protocol version and read the server's capabilities before any tool call";
  if (method === "notifications/initialized")
    return "MCP handshake: tell Box's server the client is ready";
  if (method === "tools/list")
    return "ask Box which tools its MCP server publishes";
  if (method === "tools/call")
    return `call Box MCP tool ${tool} to ${TOOL_PURPOSE[tool ?? ""] ?? "perform the requested operation"}`;
  return `MCP ${method}`;
}

async function connect(auth: TokenProvider): Promise<Client> {
  const client = new Client({ name: "box-upload-harness", version: "0.2.0" });
  const transport = new StreamableHTTPClientTransport(new URL(HOSTED_MCP), {
    fetch: async (url, init) => {
      if (new URL(String(url)).origin !== HOSTED_MCP)
        throw new Error("Untrusted MCP endpoint.");
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${await auth.getAccessToken()}`);
      // Name the JSON-RPC method — and for tools/call the tool itself — so the
      // trace shows Box's tool names rather than an opaque HTTP POST.
      // The Streamable HTTP transport opens an optional server→client SSE
      // channel with GET. Box does not offer one and answers 405, which the
      // spec permits; the client carries on over POST.
      const method = (init?.method ?? "GET").toUpperCase();
      let step =
        method === "GET" ? "open SSE channel (optional)" : "Hosted MCP HTTP";
      let why =
        method === "GET"
          ? "The MCP transport offers Box a server-to-client stream for pushing notifications. Box declines with 405, so the client sends everything over POST instead. Nothing is retried and nothing is lost."
          : "MCP message to Box's own MCP server";
      if (typeof init?.body === "string") {
        try {
          const rpc = JSON.parse(init.body);
          step =
            rpc.method === "tools/call"
              ? `Box MCP tool ${rpc.params?.name}`
              : (rpc.method ?? step);
          why = purpose(rpc.method, rpc.params?.name);
        } catch {
          /* Non-JSON transport message. */
        }
      }
      return tracedFetch(
        url,
        {
          ...init,
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
        },
        step,
        "Next.js server → Box-hosted MCP",
        auth.app ? AUTH_APP_LABEL[auth.app] : undefined,
        why,
        method === "GET" ? [405] : [409],
      );
    },
  });
  await client.connect(transport);
  return client;
}

async function withHosted<T>(
  auth: TokenProvider,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await connect(auth);
  try {
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Calls a published tool and decodes its JSON payload. */
async function call<T>(
  client: Client,
  name: HostedTool,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[] | undefined)
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();
  if (result.isError)
    throw new HttpError(
      502,
      `Box MCP tool ${name} failed${text ? `: ${text}` : "."}`,
    );
  if (result.structuredContent) return result.structuredContent as T;
  try {
    return JSON.parse(text || "{}") as T;
  } catch {
    return text as unknown as T;
  }
}

export async function inspectHostedMcp(auth: TokenProvider) {
  try {
    return await withHosted(auth, async (client) => {
      const tools = await client.listTools();
      const selected = tools.tools.filter((tool) =>
        PUBLISHED.includes(tool.name as HostedTool),
      );
      return {
        connected: true,
        tools: selected.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      };
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      502,
      "Hosted MCP inspection failed. Check the request status and integration access.",
    );
  }
}

export function hostedWhoAmI(auth: TokenProvider) {
  return withHosted(auth, (client) =>
    call<{ id: string; name: string; login: string }>(client, "who_am_i", {}),
  );
}

export function hostedListFolder(
  auth: TokenProvider,
  folderId: string,
): Promise<BoxEntry[]> {
  return withHosted(auth, async (client) =>
    entriesOf(
      await call<unknown>(client, "list_folder_content_by_folder_id", {
        folder_id: folderId,
        fields: ["id", "type", "name", "size", "modified_at"],
        limit: 200,
      }),
    ),
  );
}

/**
 * Folder-by-name, still without touching REST: search under the root, and
 * create the folder only when asked to. `search_folders_by_name` matches on
 * keywords, so the exact name is confirmed before the ID is used.
 */
export function hostedResolveFolder(
  auth: TokenProvider,
  rootFolderId: string,
  name?: string,
  create = false,
): Promise<string | null> {
  if (!name) return Promise.resolve(rootFolderId);
  const isMatch = (entry: BoxEntry) =>
    entry.type === "folder" && entry.name === name;
  return withHosted(auth, async (client) => {
    const listed = entriesOf(
      await call<unknown>(client, "list_folder_content_by_folder_id", {
        folder_id: rootFolderId,
        fields: ["id", "type", "name"],
        limit: 1000,
      }),
    ).find(isMatch);
    if (listed) return listed.id;
    const searched = entriesOf(
      await call<unknown>(client, "search_folders_by_name", {
        folder_name: name,
        ancestor_folder_id: rootFolderId,
        limit: 200,
      }),
    ).find(isMatch);
    if (searched) return searched.id;
    if (!create) return null;
    const created = await call<BoxEntry & { folder_id?: string }>(
      client,
      "create_folder",
      { name, parent_folder_id: rootFolderId },
    );
    const id = created.id ?? created.folder_id;
    if (!id)
      throw new HttpError(502, `Box MCP create_folder returned no folder id.`);
    return id;
  });
}

/**
 * The binary upload path: Box returns a single-use URL and token to POST the
 * multipart body to. Box documents both as secret, single-use, and expiring
 * after ten minutes, so they are fetched per upload and never cached.
 */
export function hostedUploadUrl(
  auth: TokenProvider,
  args: {
    fileName: string;
    fileSizeBytes: number;
    parentFolderId?: string;
    fileId?: string;
  },
) {
  return withHosted(auth, (client) =>
    call<{ upload_url: string; upload_token?: string }>(
      client,
      "get_upload_url",
      {
        file_name: args.fileName,
        file_size_bytes: args.fileSizeBytes,
        ...(args.fileId
          ? { file_id: args.fileId }
          : { parent_folder_id: args.parentFolderId ?? "0" }),
      },
    ),
  );
}

/**
 * Extensions Box documents `upload_file` as accepting, and a conservative cap:
 * the content travels inline inside a JSON-RPC message, so this is for notes
 * and small documents, not for data files.
 */
export const TEXT_EXTENSIONS = [
  "txt", "md", "boxnote", "html", "svg", "xml",
  "csv", "json", "js", "ts", "py", "sh",
];
export const TEXT_INLINE_LIMIT = 256 * 1024;

export function isSmallText(fileName: string, size: number): boolean {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return size <= TEXT_INLINE_LIMIT && TEXT_EXTENSIONS.includes(extension);
}

/** Small text files go up in a single MCP call, with no binary transfer. */
export function hostedUploadText(
  auth: TokenProvider,
  args: {
    fileName: string;
    content: string;
    parentFolderId?: string;
    fileId?: string;
  },
) {
  return withHosted(auth, (client) =>
    args.fileId
      ? call<{ file_id: string; file_name: string; size?: number }>(
          client,
          "upload_file_version",
          { file_id: args.fileId, file_content: args.content },
        )
      : call<{ file_id: string; file_name: string; size?: number }>(
          client,
          "upload_file",
          {
            file_name: args.fileName,
            file_content: args.content,
            parent_folder_id: args.parentFolderId ?? "0",
          },
        ),
  );
}

/** Finds an existing file by exact name, so uploads can add a version. */
export async function hostedFindFile(
  auth: TokenProvider,
  folderId: string,
  name: string,
): Promise<BoxEntry | undefined> {
  const items = await hostedListFolder(auth, folderId);
  return items.find((entry) => entry.type === "file" && entry.name === name);
}

/**
 * Sends the bytes to the single-use URL `get_upload_url` returned.
 *
 * This is not a REST call we chose: it is the transfer step Box's own tool
 * description prescribes, using the URL and token that tool handed back.
 */
export async function hostedPostBytes(args: {
  uploadUrl: string;
  uploadToken?: string;
  fallbackToken: string;
  fileName: string;
  parentFolderId?: string;
  bytes: Uint8Array<ArrayBuffer>;
  credential?: string;
}): Promise<BoxEntry> {
  const form = new FormData();
  form.append(
    "attributes",
    JSON.stringify(
      args.parentFolderId
        ? { name: args.fileName, parent: { id: args.parentFolderId } }
        : { name: args.fileName },
    ),
  );
  form.append("file", new Blob([args.bytes]), args.fileName);
  const response = await tracedFetch(
    args.uploadUrl,
    {
      method: "POST",
      body: form,
      headers: {
        Authorization: `Bearer ${args.uploadToken ?? args.fallbackToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15 * 60_000),
    },
    "upload bytes to get_upload_url target",
    "Next.js server → Box",
    args.credential,
    "Upload, Next.js server to Box, using the single-use URL from Box MCP get_upload_url",
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      (body as { code?: string; message?: string }).code ??
      (body as { message?: string }).message ??
      "";
    throw new HttpError(
      502,
      `Box refused the MCP upload (HTTP ${response.status}${detail ? ` ${detail}` : ""}).`,
    );
  }
  const entry = entriesOf(body)[0];
  if (!entry?.id) throw new HttpError(502, "Box did not confirm the upload.");
  return entry;
}
