#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { boxConfig } from "../box/config";
import { tokenProvider } from "../box/auth";
import { BoxClient } from "../box/client";
import { createBoxServer } from "./tools";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
loadEnv({
  path: [path.join(root, ".env")],
  quiet: true,
});

// There is no browser here to complete an OAuth redirect, so this entry point
// always runs as the CCG service account, whichever app the web app prefers.
if (!process.env.BOX_CCG_CLIENT_ID || !process.env.BOX_CCG_CLIENT_SECRET) {
  throw new Error(
    "The stdio MCP server needs CCG credentials: set BOX_CCG_CLIENT_ID and BOX_CCG_CLIENT_SECRET in .env.",
  );
}
boxConfig("ccg"); // fail fast with a specific message when the rest is incomplete
const server = createBoxServer(new BoxClient(tokenProvider(undefined, "ccg")));
await server.connect(new StdioServerTransport());
