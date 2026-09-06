import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  hostedUploadUrl,
  hostedListFolder,
  hostedResolveFolder,
  decodeInlineText,
} from "../src/mcp/hosted";
import {
  directUpload,
  DirectRefusedError,
  DirectUncertainError,
} from "../src/components/direct-upload";

const auth = {
  app: "mcp" as const,
  getAccessToken: async () => "full-secret",
  revoke: async () => {},
};
async function mockHosted(
  run: (name: string, args: Record<string, unknown>) => unknown,
  action: () => Promise<void>,
) {
  const original = {
    connect: Client.prototype.connect,
    close: Client.prototype.close,
    callTool: Client.prototype.callTool,
  };
  Client.prototype.connect = async () => {};
  Client.prototype.close = async () => {};
  Client.prototype.callTool = async ({ name, arguments: args }) => ({
    content: [{ type: "text", text: JSON.stringify(run(name, args ?? {})) }],
  });
  try {
    await action();
  } finally {
    Object.assign(Client.prototype, original);
  }
}

test("hosted tickets reject missing, broad, empty and untrusted upload credentials", async () => {
  for (const ticket of [
    { upload_url: "https://upload.box.com/api/2.0/files/content" },
    {
      upload_url: "https://upload.box.com/api/2.0/files/content",
      upload_token: "",
    },
    {
      upload_url: "https://upload.box.com/api/2.0/files/content",
      upload_token: "full-secret",
    },
    { upload_url: "https://evil.example/collect", upload_token: "scoped" },
  ])
    await mockHosted(
      () => ticket,
      async () => {
        await assert.rejects(
          hostedUploadUrl(auth, { fileName: "x.bin", fileSizeBytes: 5 }),
          (error) => {
            assert.doesNotMatch(String(error), /full-secret/);
            return true;
          },
        );
      },
    );
  await mockHosted(
    () => ({
      upload_url: "https://upload.box.com/api/2.0/files/content",
      upload_token: "ticket",
    }),
    async () => {
      assert.equal(
        (await hostedUploadUrl(auth, { fileName: "x.bin", fileSizeBytes: 5 }))
          .upload_token,
        "ticket",
      );
    },
  );
});

test("hosted listing follows clamped pages; folder lookup stays in the immediate parent", async () => {
  const offsets: unknown[] = [];
  await mockHosted(
    (name, args) => {
      assert.equal(name, "list_folder_content_by_folder_id");
      offsets.push(args.offset);
      return {
        entries: [
          {
            id: String(args.offset),
            type: "folder",
            name: args.offset === 2 ? "destination" : "other",
          },
        ],
        limit: 1,
        total_count: 3,
      };
    },
    async () => {
      assert.equal(await hostedResolveFolder(auth, "0", "destination"), "2");
      assert.deepEqual(offsets, [0, 1, 2]);
    },
  );
  await mockHosted(
    () => ({
      entries: [{ id: "same", type: "file", name: "x" }],
      limit: 1,
      total_count: 3,
    }),
    async () => {
      await assert.rejects(hostedListFolder(auth, "0"), /repeated/);
    },
  );
});

test("inline decoding preserves UTF-8 and BOMs; refuses UTF-16 and invalid sequences", () => {
  for (const bytes of [
    Buffer.from("héllo"),
    Buffer.from([0xef, 0xbb, 0xbf, 0x61]),
  ]) {
    assert.deepEqual(Buffer.from(decodeInlineText(bytes)!), bytes);
  }
  assert.equal(decodeInlineText(Buffer.from([0xff, 0xfe, 0x41, 0])), undefined);
  assert.equal(decodeInlineText(Buffer.from([0xc3, 0x28])), undefined);
});

test("a rejected chunk probe aborts before hashing, parts or commit", async () => {
  const original = globalThis.fetch;
  const actions: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (url === "/api/direct") {
      const input = JSON.parse(String(init?.body));
      actions.push(input.action);
      assert.equal(input.digest, undefined);
      return Response.json(
        input.action === "prepare"
          ? {
              strategy: "chunked",
              token: "ticket",
              directId: "id",
              partSize: 4,
              uploadUrl: "https://upload.box.com/part",
              probeUrl: "https://upload.box.com/probe",
            }
          : { aborted: true },
      );
    }
    actions.push("probe");
    assert.equal(String(url), "https://upload.box.com/probe");
    return Response.json({}, { status: 403 });
  };
  try {
    await assert.rejects(
      directUpload(new File(["test"], "x.bin"), "", () => {}),
      DirectRefusedError,
    );
    assert.deepEqual(actions, ["prepare", "probe", "finish"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("a lost simple POST response is uncertain and is never retried", async () => {
  const original = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (url) => {
    if (url === "/api/direct")
      return Response.json({
        strategy: "simple",
        token: "ticket",
        name: "x.bin",
        folderId: "0",
        uploadUrl: "https://upload.box.com/content",
      });
    posts++;
    throw new TypeError("response lost after write");
  };
  try {
    await assert.rejects(
      directUpload(new File(["test"], "x.bin"), "", () => {}),
      DirectUncertainError,
    );
    assert.equal(posts, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("a failed abort cannot be mistaken for a retryable credential refusal", async () => {
  const original = globalThis.fetch;
  const actions: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (url === "/api/direct") {
      const input = JSON.parse(String(init?.body));
      actions.push(input.action);
      return input.action === "prepare"
        ? Response.json({
            strategy: "chunked",
            token: "ticket",
            directId: "id",
            partSize: 4,
            uploadUrl: "https://upload.box.com/part",
            probeUrl: "https://upload.box.com/probe",
          })
        : Response.json({ error: "Abort failed" }, { status: 403 });
    }
    actions.push("probe");
    return Response.json({}, { status: 403 });
  };
  try {
    await assert.rejects(
      directUpload(new File(["test"], "x.bin"), "", () => {}),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof DirectRefusedError, false);
        assert.equal(error.message, "Abort failed");
        return true;
      },
    );
    assert.deepEqual(actions, ["prepare", "probe", "finish"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("a successful POST with an unreadable or missing file receipt is uncertain", async () => {
  const original = globalThis.fetch;
  try {
    for (const body of ['{"entries":', "null", '{"entries":[]}']) {
      let posts = 0;
      globalThis.fetch = async (url) => {
        if (url === "/api/direct")
          return Response.json({
            strategy: "simple",
            token: "ticket",
            name: "x.bin",
            folderId: "0",
            uploadUrl: "https://upload.box.com/content",
          });
        posts++;
        return new Response(body, { status: 201 });
      };
      await assert.rejects(
        directUpload(new File(["test"], "x.bin"), "", () => {}),
        DirectUncertainError,
      );
      assert.equal(posts, 1);
    }
  } finally {
    globalThis.fetch = original;
  }
});
