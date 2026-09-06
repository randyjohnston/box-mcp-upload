import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

type Item = {
  id: string;
  type: "file" | "folder";
  name: string;
  owner: string;
  parent: { id: string };
  size: number;
  sha1?: string;
  version: number;
};
type Upload = {
  id: string;
  owner: string;
  name: string;
  folder: string;
  size: number;
  fileId?: string;
  parts: Map<
    number,
    {
      part_id: string;
      offset: number;
      size: number;
      sha1: string;
      bytes: Buffer;
    }
  >;
  commits: number;
};
const tokens = new Map<
  string,
  { owner: string; folder?: string; expired?: boolean; singleUse?: boolean }
>();
const refresh = new Map<string, string>();
const codes = new Map<
  string,
  { challenge: string; redirect: string; owner: string; clientId: string }
>();
const items: Item[] = [];
const uploads = new Map<string, Upload>();
let next = 100;
const origin = "http://127.0.0.1:3130";
const metrics = {
  ccg: 0,
  oauth: 0,
  refresh: 0,
  downscope: 0,
  revoked: 0,
  parts: 0,
  aborted: 0,
  badPkce: 0,
  hostedCalls: [] as string[],
};
const sha1 = (bytes: Buffer) => createHash("sha1").update(bytes).digest("hex");
const id = () => String(next++);
function mint(owner: string) {
  const access_token = randomUUID();
  const refresh_token = randomUUID();
  tokens.set(access_token, { owner });
  refresh.set(refresh_token, owner);
  return {
    access_token,
    refresh_token,
    token_type: "bearer",
    expires_in: 3600,
  };
}
function save(
  owner: string,
  name: string,
  folder: string,
  bytes: Buffer,
  fileId?: string,
) {
  const existing = items.find(
    (item) => item.id === fileId && item.owner === owner,
  );
  if (existing) {
    existing.size = bytes.length;
    existing.sha1 = sha1(bytes);
    existing.version++;
    return existing;
  }
  const item: Item = {
    id: id(),
    type: "file",
    name,
    owner,
    parent: { id: folder },
    size: bytes.length,
    sha1: sha1(bytes),
    version: 1,
  };
  items.push(item);
  return item;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, origin);
  const body: Buffer[] = [];
  for await (const chunk of req) body.push(chunk);
  const raw = Buffer.concat(body);
  const send = (status: number, data: unknown = {}) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(status === 204 ? undefined : JSON.stringify(data));
  };
  const conflict = (item: Item) =>
    send(409, { code: "item_name_in_use", context_info: { conflicts: item } });
  const requestOrigin = req.headers.origin;
  if (requestOrigin && /^http:\/\/127\.0\.0\.1:310[012]$/.test(requestOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "authorization,content-type,digest,content-range",
    );
  }
  if (req.method === "OPTIONS" && req.headers["access-control-request-method"])
    return send(204);
  try {
    if (url.pathname === "/health") return send(200);
    if (url.pathname === "/metrics")
      return send(200, {
        ...metrics,
        files: items
          .filter((i) => i.type === "file")
          .map(({ name, size, version, owner, sha1 }) => ({
            name,
            size,
            version,
            owner,
            sha1,
          })),
      });
    if (url.pathname === "/expire") {
      for (const value of tokens.values())
        if (!value.folder) value.expired = true;
      return send(200);
    }
    if (url.pathname === "/authorize") {
      const challenge = url.searchParams.get("code_challenge");
      if (
        !["oauth-client", "mcp-client"].includes(
          url.searchParams.get("client_id") ?? "",
        ) ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        !challenge
      )
        return send(400);
      const code = randomUUID();
      const redirect = url.searchParams.get("redirect_uri")!;
      const boxIdentity =
        /(?:^|; )box_test_identity=([^;]+)/.exec(
          req.headers.cookie ?? "",
        )?.[1] ?? `oauth-${id()}`;
      res.setHeader(
        "Set-Cookie",
        `box_test_identity=${boxIdentity}; Path=/; HttpOnly; SameSite=Lax`,
      );
      codes.set(code, {
        challenge,
        redirect,
        owner: boxIdentity,
        clientId: url.searchParams.get("client_id")!,
      });
      const destination = new URL(redirect);
      destination.searchParams.set("code", code);
      destination.searchParams.set("state", url.searchParams.get("state")!);
      res.writeHead(302, { Location: destination.href });
      return res.end();
    }
    if (url.pathname === "/oauth2/token") {
      const form = new URLSearchParams(raw.toString());
      const grant = form.get("grant_type");
      if (grant === "client_credentials") {
        if (
          form.get("client_id") !== "ccg-client" ||
          form.get("client_secret") !== "ccg-secret" ||
          form.get("box_subject_id") !== "123"
        )
          return send(400);
        metrics.ccg++;
        return send(200, mint("ccg"));
      }
      if (grant === "authorization_code") {
        const code = codes.get(form.get("code")!);
        codes.delete(form.get("code")!);
        if (
          !code ||
          code.clientId !== form.get("client_id") ||
          code.redirect !== form.get("redirect_uri") ||
          code.challenge !==
            createHash("sha256")
              .update(form.get("code_verifier") ?? "")
              .digest("base64url")
        ) {
          metrics.badPkce++;
          return send(400, { error: "invalid_grant" });
        }
        if (!(
          (form.get("client_id") === "oauth-client" &&
            form.get("client_secret") === "oauth-secret") ||
          (form.get("client_id") === "mcp-client" &&
            form.get("client_secret") === "mcp-secret")
        ))
          return send(400);
        metrics.oauth++;
        return send(200, mint(code.owner));
      }
      if (grant === "refresh_token") {
        const owner = refresh.get(form.get("refresh_token")!);
        refresh.delete(form.get("refresh_token")!);
        if (!owner) return send(400);
        metrics.refresh++;
        return send(200, mint(owner));
      }
      if (grant === "urn:ietf:params:oauth:grant-type:token-exchange") {
        const parent = tokens.get(form.get("subject_token")!);
        if (!parent || parent.expired || form.get("scope") !== "base_upload")
          return send(400);
        const folder = form.get("resource")!.split("/").pop()!;
        const token = randomUUID();
        tokens.set(token, { owner: parent.owner, folder });
        metrics.downscope++;
        return send(200, {
          access_token: token,
          token_type: "bearer",
          expires_in: 900,
          restricted_to: [
            { scope: "base_upload", object: { id: folder, type: "folder" } },
          ],
        });
      }
      return send(400);
    }
    if (url.pathname === "/oauth2/revoke") {
      tokens.delete(new URLSearchParams(raw.toString()).get("token")!);
      metrics.revoked++;
      return send(200);
    }
    const auth = tokens.get(
      req.headers.authorization?.replace("Bearer ", "") ?? "",
    );
    if (!auth || auth.expired)
      return send(401, { message: "secret-upstream-detail" });
    const owner = auth.owner;
    if (url.pathname === "/mcp") {
      if (auth.folder) return send(403);
      if (req.method === "GET") return send(405);
      if (req.method === "DELETE") return send(204);
      const rpc = JSON.parse(raw.toString());
      const reply = (result: unknown) =>
        send(200, { jsonrpc: "2.0", id: rpc.id, result });
      if (rpc.method === "initialize")
        return reply({
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "Box simulator", version: "1" },
        });
      if (rpc.method.startsWith("notifications/")) return send(202);
      const names = [
        "who_am_i",
        "list_folder_content_by_folder_id",
        "create_folder",
        "get_upload_url",
        "upload_file",
        "upload_file_version",
      ];
      if (rpc.method === "tools/list")
        return reply({
          tools: names.map((name) => ({
            name,
            inputSchema: { type: "object", properties: {} },
          })),
        });
      if (rpc.method !== "tools/call") return send(400);
      const { name, arguments: args } = rpc.params;
      metrics.hostedCalls.push(name);
      const result = (data: unknown, isError = false) =>
        reply({
          content: [{ type: "text", text: JSON.stringify(data) }],
          isError,
        });
      const children = (folder: string) =>
        items.filter(
          (item) => item.owner === owner && item.parent.id === folder,
        );
      if (name === "who_am_i")
        return result({
          id: owner,
          name: owner,
          login: `${owner}@example.test`,
        });
      if (name === "list_folder_content_by_folder_id") {
        const all = children(args.folder_id);
        const offset = Number(args.offset ?? 0);
        // Deliberately clamp pages to exercise clients' pagination logic.
        return result({
          entries: all.slice(offset, offset + 2),
          offset,
          limit: 2,
          total_count: all.length,
        });
      }
      if (name === "create_folder") {
        if (
          children(args.parent_folder_id).some(
            (item) => item.name === args.name,
          )
        )
          return result({ code: "item_name_in_use" }, true);
        const folder: Item = {
          id: id(),
          type: "folder",
          name: args.name,
          owner,
          parent: { id: args.parent_folder_id },
          size: 0,
          version: 1,
        };
        items.push(folder);
        return result(folder);
      }
      const existing = args.file_id
        ? items.find((item) => item.id === args.file_id && item.owner === owner)
        : undefined;
      if (args.file_id && !existing) return result({ code: "not_found" }, true);
      const folder = existing?.parent.id ?? args.parent_folder_id;
      const fileName = existing?.name ?? args.file_name;
      if (!existing && children(folder).some((item) => item.name === fileName))
        return result({ code: "item_name_in_use" }, true);
      if (name === "get_upload_url") {
        const token = randomUUID();
        tokens.set(token, { owner, folder, singleUse: true });
        return result({
          upload_url: `${origin}/api/2.0/files/${existing ? `${existing.id}/` : ""}content`,
          upload_token: token,
        });
      }
      if (name === "upload_file" || name === "upload_file_version") {
        const file = save(
          owner,
          fileName,
          folder,
          Buffer.from(args.file_content, "utf8"),
          existing?.id,
        );
        return result({
          file_id: file.id,
          file_name: file.name,
          size: file.size,
        });
      }
      return result({ error: "unknown_tool" }, true);
    }
    const path = url.pathname.replace(/^\/(api\/)?2\.0/, "");
    if (path === "/users/me")
      return send(200, {
        id: owner,
        name: owner,
        login: `${owner}@example.test`,
      });
    if (path === "/folders" && req.method === "POST") {
      const input = JSON.parse(raw.toString());
      const existing = items.find(
        (item) =>
          item.owner === owner &&
          item.parent.id === input.parent.id &&
          item.name === input.name,
      );
      if (existing) return conflict(existing);
      const item: Item = {
        id: id(),
        type: "folder",
        owner,
        name: input.name,
        parent: input.parent,
        size: 0,
        version: 1,
      };
      items.push(item);
      return send(201, item);
    }
    const folder = /^\/folders\/(\d+)\/items$/.exec(path);
    if (folder) {
      const entries = items.filter(
        (item) => item.owner === owner && item.parent.id === folder[1],
      );
      const offset = Number(url.searchParams.get("marker") ?? "0");
      return send(200, {
        entries: entries.slice(offset, offset + 2),
        next_marker: offset + 2 < entries.length ? String(offset + 2) : null,
      });
    }
    const simple = /^\/files\/(\d+\/)?content$/.exec(path);
    if (simple) {
      if (req.method === "OPTIONS") {
        if (raw.length) {
          const input = JSON.parse(raw.toString());
          const existing = items.find(
            (item) =>
              item.owner === owner &&
              item.parent.id === input.parent.id &&
              item.name === input.name,
          );
          if (existing) return conflict(existing);
        }
        return send(200, { upload_url: `${origin}/api/2.0/files/content` });
      }
      const web = new Request(url, {
        method: "POST",
        headers: { "Content-Type": req.headers["content-type"]! },
        body: raw,
      });
      const form = await web.formData();
      const input = JSON.parse(String(form.get("attributes")));
      const file = form.get("file") as File;
      const fileId = simple[1]?.replace("/", "");
      const parent = fileId
        ? items.find((item) => item.id === fileId)?.parent.id
        : input.parent.id;
      if (auth.folder && auth.folder !== parent) return send(403);
      const existing = items.find(
        (item) =>
          item.owner === owner &&
          item.parent.id === parent &&
          item.name === input.name,
      );
      if (!fileId && existing) return conflict(existing);
      if (auth.singleUse)
        tokens.delete(req.headers.authorization!.replace("Bearer ", ""));
      return send(201, {
        entries: [
          save(
            owner,
            input.name,
            parent,
            Buffer.from(await file.arrayBuffer()),
            fileId,
          ),
        ],
      });
    }
    const create = /^\/files\/(\d+\/)?upload_sessions$/.exec(path);
    if (create && req.method === "POST") {
      const input = JSON.parse(raw.toString());
      const fileId = create[1]?.replace("/", "");
      const folder = fileId
        ? items.find((item) => item.id === fileId)!.parent.id
        : input.folder_id;
      const existing = items.find(
        (item) =>
          item.owner === owner &&
          item.parent.id === folder &&
          item.name === input.file_name,
      );
      if (!fileId && existing) return conflict(existing);
      const sessionId = id();
      uploads.set(sessionId, {
        id: sessionId,
        owner,
        name: input.file_name,
        size: input.file_size,
        folder,
        fileId,
        parts: new Map(),
        commits: 0,
      });
      const base = `${origin}/api/2.0/files/upload_sessions/${sessionId}`;
      return send(201, {
        id: sessionId,
        part_size: 8 * 1024 ** 2,
        total_parts: Math.ceil(input.file_size / (8 * 1024 ** 2)),
        session_endpoints: {
          upload_part: base,
          status: base,
          list_parts: `${base}/parts`,
          commit: `${base}/commit`,
          abort: base,
        },
      });
    }
    const match = /^\/files\/upload_sessions\/(\d+)(\/parts|\/commit)?$/.exec(
      path,
    );
    if (match) {
      const upload = uploads.get(match[1]);
      if (!upload || upload.owner !== owner) return send(404);
      if (auth.folder && auth.folder !== upload.folder) return send(403);
      if (req.method === "DELETE") {
        uploads.delete(match[1]);
        metrics.aborted++;
        return send(204);
      }
      if (req.method === "GET")
        return send(200, {
          entries: [...upload.parts.values()]
            .sort((a, b) => a.offset - b.offset)
            .map(({ bytes: _, ...part }) => part),
          total_count: upload.parts.size,
        });
      if (req.method === "PUT") {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          String(req.headers["content-range"]),
        );
        if (
          !range ||
          Number(range[2]) - Number(range[1]) + 1 !== raw.length ||
          Number(range[3]) !== upload.size ||
          req.headers.digest !==
            `sha=${createHash("sha1").update(raw).digest("base64")}`
        )
          return send(400);
        const part = {
          part_id: id(),
          offset: Number(range[1]),
          size: raw.length,
          sha1: sha1(raw),
          bytes: raw,
        };
        upload.parts.set(part.offset, part);
        metrics.parts++;
        const { bytes: _, ...receipt } = part;
        return send(200, { part: receipt });
      }
      if (match[2] === "/commit") {
        const parts = [...upload.parts.values()].sort(
          (a, b) => a.offset - b.offset,
        );
        const all = Buffer.concat(parts.map((part) => part.bytes));
        const input = JSON.parse(raw.toString());
        if (
          all.length !== upload.size ||
          input.parts.length !== parts.length ||
          req.headers.digest !==
            `sha=${createHash("sha1").update(all).digest("base64")}`
        )
          return send(400);
        if (!upload.commits++) {
          res.setHeader("Retry-After", "0");
          return send(202);
        }
        const file = save(
          owner,
          upload.name,
          upload.folder,
          all,
          upload.fileId,
        );
        uploads.delete(upload.id);
        return send(201, { entries: [file] });
      }
    }
    return send(404);
  } catch {
    return send(500);
  }
});
server.listen(3130, "127.0.0.1", () => console.log("Box simulator ready"));
