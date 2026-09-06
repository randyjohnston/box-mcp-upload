import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, readdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoxClient, BoxApiError, retryDelayMs } from "../src/box/client";
import {
  stageUpload,
  claimUpload,
  discardUpload,
  readStaged,
  sweepStale,
} from "../src/staging";
import { assertSafeName, resolveFolder } from "../src/box/folders";
import { boxConfig, appOrigin } from "../src/box/config";
import { tokenProvider } from "../src/box/auth";

process.env.BOX_CCG_CLIENT_ID = "test";
process.env.BOX_CCG_CLIENT_SECRET = "test";
process.env.BOX_CCG_ENTERPRISE_ID = "1";
const provider = {
  getAccessToken: async () => "server-only-token",
  revoke: async () => undefined,
};

test("rejects token forwarding to an untrusted endpoint", async () => {
  const client = new BoxClient(provider);
  await assert.rejects(
    client.fetch("https://attacker.example/collect"),
    /Untrusted/,
  );
  await assert.rejects(
    client.fetch("https://api.box.com@attacker.example/collect"),
    /Untrusted/,
  );
});

test("never retries uncertain POST writes; retries safe reads and clamps backoff", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json(
      { message: "secret" },
      { status: requests === 1 ? 500 : 200 },
    );
  };
  try {
    await assert.rejects(
      new BoxClient(provider).fetch("/files", { method: "POST" }),
      (error) =>
        error instanceof BoxApiError && !error.message.includes("secret"),
    );
    assert.equal(requests, 1);
    requests = 0;
    assert.equal((await new BoxClient(provider).fetch("/files")).status, 200);
    assert.equal(requests, 2);
    assert.equal(
      retryDelayMs(
        new Response(null, { headers: { "Retry-After": "999999" } }),
        0,
      ),
      30_000,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("stage limits, atomic claims, ownership and cleanup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-unit-"));
  process.env.STAGING_DIR = directory;
  try {
    await assert.rejects(
      stageUpload(
        Readable.from([Buffer.alloc(8), Buffer.alloc(8)]),
        "large.bin",
        10,
      ),
    );
    await assert.rejects(stageUpload(Readable.from([]), "empty.bin", 10));
    assert.deepEqual(await readdir(directory), []);
    const upload = await stageUpload(
      Readable.from(["content"]),
      "file.txt",
      100,
      "owner-a",
    );
    await assert.rejects(readStaged(upload.uploadId, "owner-b"), /not found/);
    const claims = await Promise.allSettled([
      claimUpload(upload.uploadId, "owner-a"),
      claimUpload(upload.uploadId, "owner-a"),
    ]);
    assert.equal(
      claims.filter((result) => result.status === "fulfilled").length,
      1,
    );
    await discardUpload(upload.uploadId);
    assert.deepEqual(await readdir(directory), []);
    const unknown = path.join(directory, "do-not-delete.txt");
    await writeFile(unknown, "unrelated");
    await utimes(unknown, 0, 0);
    await sweepStale(1);
    assert.deepEqual(await readdir(directory), ["do-not-delete.txt"]);
  } finally {
    delete process.env.STAGING_DIR;
    await rm(directory, { recursive: true, force: true });
  }
});

test("listing a missing destination does not create folders", async () => {
  const methods: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_, init) => {
    methods.push(init?.method ?? "GET");
    return Response.json({ entries: [] });
  };
  try {
    assert.equal(
      await resolveFolder(new BoxClient(provider), "does-not-exist"),
      null,
    );
    assert.deepEqual(methods, ["GET"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("configuration and file names fail closed", () => {
  for (const name of ["", ".", "..", "../x", "x/y", "x\u007f"])
    assert.throws(() => assertSafeName(name, "file"));
  delete process.env.BOX_CCG_CLIENT_ID;
  assert.throws(boxConfig, /configuration/);
  process.env.BOX_CCG_CLIENT_ID = "test";
  process.env.APP_ORIGIN = "http://example.com";
  assert.throws(appOrigin);
  delete process.env.APP_ORIGIN;
});

test("OAuth refresh rotates once, handles 401 races, and prevents use after revoke", async () => {
  const original = globalThis.fetch;
  process.env.BOX_OAUTH_CLIENT_ID = "test";
  process.env.BOX_OAUTH_CLIENT_SECRET = "test";
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({
      access_token: "fresh",
      refresh_token: "rotated",
      token_type: "bearer",
      expires_in: 3600,
    });
  };
  try {
    const auth = tokenProvider({
      accessToken: "expired",
      refreshToken: "once-only",
      expiresAt: 0,
    });
    assert.deepEqual(
      await Promise.all(Array.from({ length: 5 }, () => auth.getAccessToken())),
      Array(5).fill("fresh"),
    );
    assert.equal(requests, 1);
    assert.equal(await auth.getAccessToken("expired"), "fresh");
    assert.equal(requests, 1);
    await auth.revoke();
    await assert.rejects(auth.getAccessToken(), /reconnect/);
  } finally {
    globalThis.fetch = original;
  }
});

test("trusts the upload host Box actually returns, and nothing that merely looks like it", async () => {
  const client = new BoxClient(provider);
  // Box hands back upload-session endpoints on upload.app.box.com, so a
  // fixed api/upload host pair silently breaks every chunked upload.
  const original = globalThis.fetch;
  let reached = "";
  globalThis.fetch = async (input: RequestInfo | URL) => {
    reached = String(input);
    return Response.json({});
  };
  try {
    await client.fetch(
      "https://upload.app.box.com/api/2.0/files/upload_sessions/abc",
    );
    assert.match(reached, /^https:\/\/upload\.app\.box\.com\//);
  } finally {
    globalThis.fetch = original;
  }

  // Lookalike hosts and plaintext must still be refused.
  for (const url of [
    "https://upload.app.box.com.attacker.example/x",
    "https://notbox.com/x",
    "http://upload.app.box.com/x",
    "https://upload.app.box.com@attacker.example/x",
  ])
    await assert.rejects(client.fetch(url), /Untrusted/, url);
});

test("request traces exclude credentials and preserve failed request status", async () => {
  const { traceRequests, tracedFetch } = await import("../src/telemetry");
  const { HttpError } = await import("../src/errors");
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ token: "response-secret" }, { status: 401 });
  try {
    await assert.rejects(
      traceRequests("test", async () => {
        await tracedFetch(
          "https://api.box.com/oauth2/token?code=query-secret",
          {
            method: "POST",
            headers: { Authorization: "Bearer header-secret" },
            body: "client_secret=body-secret",
          },
        );
        throw new HttpError(401, "Reconnect.");
      }),
      (error) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.requests?.[0].status, 401);
        assert.equal(error.requests?.[0].target, "api.box.com/oauth2/token");
        assert.doesNotMatch(
          JSON.stringify(error.requests),
          /secret|Bearer|Authorization/,
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("browser token is refused unless upload-only and restricted to the requested folder", async () => {
  const { prepareDirect } = await import("../src/box/direct");
  const original = globalThis.fetch;
  const originalRoot = process.env.BOX_CCG_ROOT_FOLDER_ID;
  process.env.BOX_CCG_ROOT_FOLDER_ID = "0";
  const valid = { scope: "base_upload", object: { id: "0", type: "folder" } };
  try {
    for (const restrictions of [
      undefined,
      [],
      [{ ...valid, scope: "root_readwrite" }],
      [{ ...valid, object: { id: "other", type: "folder" } }],
      [valid, { ...valid, scope: "base_download" }],
    ]) {
      globalThis.fetch = async () =>
        Response.json({
          access_token: "must-not-leak",
          expires_in: 3600,
          token_type: "bearer",
          restricted_to: restrictions,
        });
      await assert.rejects(
        prepareDirect(
          new BoxClient(provider),
          provider,
          "owner",
          "test.bin",
          100,
        ),
        /upload-only token restricted/,
      );
    }
  } finally {
    globalThis.fetch = original;
    if (originalRoot === undefined) delete process.env.BOX_CCG_ROOT_FOLDER_ID;
    else process.env.BOX_CCG_ROOT_FOLDER_ID = originalRoot;
  }
});

test("each authentication option selects its own credentials and destination root", async () => {
  const before = { ...process.env };
  try {
    process.env.BOX_MCP_CLIENT_ID = "mcp-id";
    process.env.BOX_MCP_CLIENT_SECRET = "mcp-secret";
    process.env.BOX_OAUTH_CLIENT_ID = "platform-id";
    process.env.BOX_OAUTH_CLIENT_SECRET = "platform-secret";
    process.env.BOX_CCG_CLIENT_ID = "ccg-id";
    process.env.BOX_CCG_CLIENT_SECRET = "ccg-secret";
    process.env.BOX_CCG_ROOT_FOLDER_ID = "123";
    process.env.BOX_USER_ROOT_FOLDER_ID = "456";
    assert.equal(boxConfig("mcp").clientId, "mcp-id");
    assert.equal(boxConfig("platform").clientId, "platform-id");
    assert.equal(boxConfig("ccg").clientId, "ccg-id");
    assert.equal(
      new BoxClient(tokenProvider(undefined, "ccg")).rootFolderId,
      "123",
    );
    assert.equal(
      new BoxClient(tokenProvider(undefined, "platform")).rootFolderId,
      "456",
    );
    delete process.env.BOX_CCG_CLIENT_SECRET;
    assert.throws(() => boxConfig("ccg"));
    assert.equal(boxConfig("mcp").clientId, "mcp-id");
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});
