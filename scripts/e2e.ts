// Live Platform CCG tests through the standalone local MCP server.
// Creates simple/chunked files and versions in the e2e folder.

import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { stageUpload } from "../src/staging";

const FOLDER = "e2e";
const MB = 1024 * 1024;

function fakeFile(bytes: number): Readable {
  // Emitted in 1 MB chunks so we never hold the whole file in memory twice.
  let remaining = bytes;
  return new Readable({
    read() {
      if (remaining <= 0) return void this.push(null);
      const size = Math.min(MB, remaining);
      remaining -= size;
      this.push(randomBytes(size));
    },
  });
}

type UploadResult = {
  id: string;
  name: string;
  size: number;
  strategy: string;
  newVersion: boolean;
  folderId: string;
};

async function main() {
  const client = new Client({ name: "e2e", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/mcp/server.ts"],
    }),
  );

  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));

  const identity = await client.callTool({ name: "box_whoami", arguments: {} });
  if (identity.isError)
    throw new Error(JSON.stringify(identity.structuredContent));
  const who = identity.structuredContent as { name: string; login: string };
  console.log(`authenticated as ${who.name} <${who.login}>`);

  async function upload(name: string, size: number): Promise<UploadResult> {
    const staged = await stageUpload(fakeFile(size), name, 1024 * MB);
    let lastMessage = "";
    const started = Date.now();
    const res = await client.callTool(
      {
        name: "box_upload_file",
        arguments: { uploadId: staged.uploadId, folder: FOLDER },
      },
      undefined,
      {
        onprogress: (p) => {
          const pct = p.total ? Math.round((p.progress / p.total) * 100) : 0;
          if (p.message !== lastMessage) {
            lastMessage = p.message ?? "";
            console.log(`  progress ${pct}% (${p.message})`);
          }
        },
      },
    );
    if (res.isError) throw new Error(JSON.stringify(res.structuredContent));
    const out = res.structuredContent as UploadResult;
    console.log(
      `  -> Box file ${out.id} via ${out.strategy} upload in ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s` +
        (out.newVersion ? " (new version)" : ""),
    );
    return out;
  }

  for (const [label, size] of [
    ["small", 2 * MB],
    ["large", 25 * MB],
  ] as const) {
    const name = `e2e-${label}-${Date.now()}.bin`;
    const expected = size >= 20 * MB ? "chunked" : "simple";

    console.log(
      `\n${label}: ${(size / MB).toFixed(1)} MB, expecting a ${expected} upload`,
    );
    const first = await upload(name, size);
    if (first.strategy !== expected)
      throw new Error(`expected ${expected}, got ${first.strategy}`);
    if (first.newVersion)
      throw new Error("first upload should not be a new version");

    // Same name again: Box answers 409, and the upload path must fall back to
    // adding a version to the existing file rather than failing.
    console.log(
      `${label}: re-uploading the same name to exercise the conflict path`,
    );
    const second = await upload(name, size);
    if (!second.newVersion)
      throw new Error("re-upload should have added a new version");
    if (second.id !== first.id)
      throw new Error("new version should reuse the same file ID");
  }

  const listed = (
    await client.callTool({
      name: "box_list_folder",
      arguments: { folder: FOLDER },
    })
  ).structuredContent as { items: { name: string; size?: number }[] };
  console.log(`\n${FOLDER}/ now holds ${listed.items.length} item(s):`);
  for (const item of listed.items.slice(-5)) {
    console.log(`  ${item.name} (${((item.size ?? 0) / MB).toFixed(1)} MB)`);
  }

  await client.close();
  console.log("\nE2E OK");
}

main().catch((err) => {
  console.error("\nE2E FAILED:", err);
  process.exit(1);
});
