import { test, expect, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
const simulator = "http://127.0.0.1:3130";
const serverToggle = "Let the Next.js server carry file bytes";

async function platformConnect(page: Page, mode: "ccg" | "oauth") {
  await page
    .getByRole("radio", {
      name: mode === "ccg" ? /Client credentials/ : /Authorization code/,
    })
    .check();
  if (mode === "ccg" && (await page.getByLabel("Access password").isVisible()))
    await page.getByLabel("Access password").fill("test-workspace-password");
  await Promise.all([
    page.waitForResponse(async (response) => {
      if (!response.url().endsWith("/api/auth/session") || !response.ok())
        return false;
      const session = await response.json();
      return session.apps.some(
        (app: { app: string; connected: boolean }) =>
          app.app === (mode === "ccg" ? "ccg" : "platform") && app.connected,
      );
    }),
    page.locator(".auth-card form").getByRole("button").click(),
  ]);
  await expect(page.locator(".connection")).toContainText("Box connected");
}
async function connect(page: Page) {
  await page.goto("/");
  if (test.info().project.name === "mcp") {
    await page
      .getByRole("button", { name: "Connect MCP integration", exact: true })
      .click();
    await expect(page.locator(".connection")).toContainText("MCP integration");
  } else
    await platformConnect(page, test.info().project.name as "ccg" | "oauth");
}
async function choose(page: Page, name: string, buffer: Buffer) {
  await page
    .getByLabel("Choose files")
    .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
}
async function saved(page: Page) {
  await expect(page.locator(".transfer-status").last()).toContainText(
    "Saved to Box",
    { timeout: 60_000 },
  );
}
const unique = (prefix: string) =>
  `${prefix}-${test.info().project.name}-${Date.now()}`;

for (const fallback of [false, true]) {
  test(`${fallback ? "server fallback" : "direct"}: simple, large, versions and hashes`, async ({
    page,
    request,
  }) => {
    await connect(page);
    await page.getByLabel("Destination folder").fill(unique("uploads"));
    let stages = 0;
    page.on("request", (req) => {
      if (req.url().endsWith("/api/uploads")) stages++;
    });
    // An explicit refusal is safe to retry. An opaque simple POST failure is not.
    if (fallback)
      await page.route(`${simulator}/api/2.0/**`, (route) =>
        route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ code: "cors_origin_not_whitelisted" }),
        }),
      );
    for (const size of [2048, 21 * 1024 ** 2]) {
      const name = `${unique(String(size))}.bin`;
      const buffer = randomBytes(size);
      for (let version = 1; version <= 2; version++) {
        await choose(page, name, buffer);
        await saved(page);
        await expect(page.locator(".transfer-status").last()).toContainText(
          fallback ? "Next.js server" : "browser",
        );
        if (version === 2)
          await expect(page.locator(".transfer-status").last()).toContainText(
            "New version",
          );
        await expect(
          page.getByRole("link", { name, exact: true }),
        ).toBeVisible();
      }
      const metrics = await (await request.get(`${simulator}/metrics`)).json();
      expect(
        metrics.files.find((f: { name: string }) => f.name === name),
      ).toMatchObject({
        size,
        version: 2,
        sha1: createHash("sha1").update(buffer).digest("hex"),
      });
    }
    expect(stages).toBe(fallback ? 4 : 0);
  });
}

test("opaque simple POST failure stops without staging or another version", async ({
  page,
  request,
}) => {
  await connect(page);
  let stages = 0;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/uploads")) stages++;
  });
  // Actually save the file, then drop the response: the ambiguous-write case.
  await page.route(`${simulator}/api/2.0/files/**`, async (route) => {
    await route.fetch();
    await route.abort("connectionreset");
  });
  const name = `${unique("uncertain")}.bin`;
  await choose(page, name, Buffer.from("accepted once"));
  await expect(page.locator(".transfer-status").last()).toContainText(
    "outcome is uncertain",
  );
  expect(stages).toBe(0);
  const metrics = await (await request.get(`${simulator}/metrics`)).json();
  expect(
    metrics.files.filter((f: { name: string }) => f.name === name),
  ).toMatchObject([{ version: 1 }]);
});

test("failed chunk reachability aborts before server fallback", async ({
  page,
  request,
}) => {
  test.skip(
    test.info().project.name === "mcp",
    "Hosted MCP uses a single POST, not chunks",
  );
  await connect(page);
  const before = await (await request.get(`${simulator}/metrics`)).json();
  await page.route(`${simulator}/api/2.0/files/upload_sessions/**`, (route) =>
    route.abort("blockedbyclient"),
  );
  await choose(
    page,
    `${unique("blocked-chunks")}.bin`,
    Buffer.alloc(21 * 1024 ** 2),
  );
  await saved(page);
  const after = await (await request.get(`${simulator}/metrics`)).json();
  expect(after.aborted - before.aborted).toBe(1);
  await expect(page.locator(".transfer-status").last()).toContainText(
    "Next.js server",
  );
});

test("server bytes disabled stops explicit refusal and MCP inline text", async ({
  page,
}) => {
  await connect(page);
  await page.getByLabel(serverToggle).uncheck();
  let stages = 0;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/uploads")) stages++;
  });
  if (test.info().project.name === "mcp") {
    await choose(page, "note.txt", Buffer.from("server forbidden"));
    await expect(page.locator(".transfer-status").last()).toContainText(
      "server bytes are disabled",
    );
  } else {
    await page.route(`${simulator}/api/2.0/**`, (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: "{}",
      }),
    );
    await choose(page, `${unique("denied")}.bin`, Buffer.alloc(2048));
    await expect(page.locator(".transfer-status").last()).toContainText(
      "fallback is off",
    );
  }
  expect(stages).toBe(0);
});

test("HTTP 400 does not trigger fallback", async ({ page }) => {
  await connect(page);
  await page.route(`${simulator}/api/2.0/**`, (route) =>
    route.fulfill({ status: 400, contentType: "application/json", body: "{}" }),
  );
  let stages = 0;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/uploads")) stages++;
  });
  await choose(page, `${unique("bad-request")}.bin`, Buffer.alloc(100));
  await expect(page.locator(".transfer-status").last()).toContainText(
    "HTTP 400",
  );
  expect(stages).toBe(0);
});

test("authentication, CSRF, ownership, atomic commit and logout", async ({
  page,
  browser,
  request,
  baseURL,
}) => {
  expect((await request.get("/api/files")).status()).toBe(401);
  expect((await request.post("/api/uploads", { data: "x" })).status()).toBe(
    403,
  );
  await connect(page);
  const api = page.context().request;
  const headers = { Origin: baseURL!, "x-file-name": "test.bin" };
  for (const name of ["%GG", "..%2Fsecret"])
    expect(
      (
        await api.post("/api/uploads", {
          headers: { ...headers, "x-file-name": name },
          data: "x",
        })
      ).status(),
    ).toBe(400);
  expect(
    (
      await api.post("/api/uploads", {
        headers: { ...headers, Origin: "https://evil.example" },
        data: "x",
      })
    ).status(),
  ).toBe(403);
  const staged = await (
    await api.post("/api/uploads", { headers, data: "owned" })
  ).json();
  const other = await browser.newContext({ baseURL });
  await connect(await other.newPage());
  expect(
    (
      await other.request.post(`/api/uploads/${staged.uploadId}/commit`, {
        headers,
        data: {},
      })
    ).status(),
  ).toBe(404);
  await other.close();
  expect(
    (
      await api.post(`/api/uploads/${staged.uploadId}/commit`, {
        headers,
        data: { folder: 42 },
      })
    ).status(),
  ).toBe(400);
  const committed = await api.post(`/api/uploads/${staged.uploadId}/commit`, {
    headers,
    data: { folder: unique("security") },
  });
  expect(await committed.text()).toContain("event: done");
  expect(
    (
      await api.post(`/api/uploads/${staged.uploadId}/commit`, {
        headers,
        data: {},
      })
    ).status(),
  ).toBe(404);
  expect(
    (await page.context().cookies()).find((c) => c.name === "box_session"),
  ).toMatchObject({ httpOnly: true, sameSite: "Lax" });
  await page
    .getByRole("button", { name: "Disconnect all", exact: true })
    .click();
  await expect(page.locator(".connection")).toContainText("Not connected");
  expect((await api.get("/api/files")).status()).toBe(401);
});

test("concurrent requests share one token renewal", async ({
  page,
  request,
}) => {
  await connect(page);
  await expect(page.getByText("Loading files…", { exact: true })).toBeHidden();
  const before = await (await request.get(`${simulator}/metrics`)).json();
  await request.post(`${simulator}/expire`);
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => page.context().request.get("/api/files")),
  );
  expect(responses.every((r) => r.ok())).toBe(true);
  const after = await (await request.get(`${simulator}/metrics`)).json();
  const field = test.info().project.name === "ccg" ? "ccg" : "refresh";
  expect(after[field] - before[field]).toBe(1);
});

test("OAuth state is browser-bound and single-use", async ({
  page,
  request,
  baseURL,
}) => {
  test.skip(test.info().project.name === "ccg");
  expect(
    (await request.get("/api/auth/callback?code=fake&state=fake")).status(),
  ).toBe(400);
  const login = await (
    await request.post("/api/auth/login", {
      headers: { Origin: baseURL! },
      data: { app: "platform" },
    })
  ).json();
  const authorize = await request.get(login.url, { maxRedirects: 0 });
  const callback = authorize.headers().location;
  expect(
    (await page.context().request.get(callback, { maxRedirects: 0 })).status(),
  ).toBe(400);
  expect((await request.get(callback, { maxRedirects: 0 })).status()).toBe(303);
  expect((await request.get(callback, { maxRedirects: 0 })).status()).toBe(400);
});

test("responsive UI and empty-file validation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await connect(page);
  await choose(page, "empty.txt", Buffer.alloc(0));
  await expect(page.locator(".transfer-status").last()).toContainText(
    "non-empty",
  );
  const overflow = await page.evaluate(() => ({
    width: innerWidth,
    actual: document.documentElement.scrollWidth,
    elements: [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > innerWidth)
      .slice(0, 12)
      .map((el) => el.tagName + "." + el.className),
  }));
  expect(overflow.actual, JSON.stringify(overflow)).toBeLessThanOrEqual(
    overflow.width,
  );
});

test("platform flow selection is explicit and releases the previous platform credential", async ({
  page,
}) => {
  test.skip(test.info().project.name === "mcp");
  await connect(page);
  const next = test.info().project.name === "ccg" ? "oauth" : "ccg";
  await platformConnect(page, next);
  const session = await (
    await page.context().request.get("/api/auth/session")
  ).json();
  expect(session.primaryApp).toBe(next === "oauth" ? "platform" : "ccg");
  expect(
    session.apps.filter((app: { connected: boolean }) => app.connected),
  ).toHaveLength(1);
  await choose(page, `${unique("switched")}.bin`, Buffer.alloc(100));
  await saved(page);
});

test("MCP and Platform OAuth retry in the same account and list the saved file", async ({
  page,
}) => {
  test.skip(test.info().project.name !== "mcp");
  await connect(page);
  await platformConnect(page, "oauth");
  await expect(page.locator(".fallback-state")).toContainText("Retry order");
  const session = await (
    await page.context().request.get("/api/auth/session")
  ).json();
  expect(session).toMatchObject({
    primaryApp: "mcp",
    fallbackApp: "platform",
    fallbackArmed: true,
  });
  let attempts = 0;
  let stages = 0;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/uploads")) stages++;
  });
  await page.route(`${simulator}/api/2.0/**`, (route) =>
    ++attempts === 1
      ? route.fulfill({
          status: 403,
          contentType: "application/json",
          body: "{}",
        })
      : route.continue(),
  );
  const name = `${unique("credential-retry")}.bin`;
  await choose(page, name, Buffer.from("same destination"));
  await saved(page);
  await expect(page.locator(".transfer-status").last()).toContainText(
    "browser · Platform OAuth",
  );
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  expect(stages).toBe(0);
});

test("cross-account fallback stays available and labels the saved destination", async ({
  page,
}) => {
  test.skip(test.info().project.name !== "mcp");
  await connect(page);
  await platformConnect(page, "ccg");
  await expect(page.locator(".fallback-state")).toContainText("Retry order");
  let attempts = 0;
  await page.route(`${simulator}/api/2.0/**`, (route) =>
    ++attempts === 1
      ? route.fulfill({
          status: 403,
          contentType: "application/json",
          body: "{}",
        })
      : route.continue(),
  );
  await choose(
    page,
    `${unique("cross-account")}.bin`,
    Buffer.from("test harness"),
  );
  await saved(page);
  await expect(page.locator(".transfer-status").last()).toContainText(
    "Platform CCG · ccg (ccg) · root 0",
  );
  await expect(
    page.getByRole("link", { name: "Open saved file", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Listing the primary account/)).toBeVisible();
});

test("hosted MCP text, UTF-16 binary preservation, pagination and versions", async ({
  page,
  request,
}) => {
  test.skip(test.info().project.name !== "mcp");
  await connect(page);
  await page.getByLabel("Destination folder").fill(unique("hosted"));
  const inputs = [
    ["one.txt", Buffer.from("first")],
    ["two.txt", Buffer.from("second")],
    ["bom.txt", Buffer.from([0xef, 0xbb, 0xbf, 0x61])],
    ["utf16.txt", Buffer.from([0xff, 0xfe, 0x41, 0])],
  ] as const;
  for (const [name, bytes] of [...inputs, inputs[3]]) {
    await choose(page, name, bytes);
    await saved(page);
    await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await expect(page.locator(".transfer-status").last()).toContainText(
    "New version",
  );
  await expect(page.locator(".file-list li")).toHaveCount(4);
  const session = await (
    await page.context().request.get("/api/auth/session")
  ).json();
  const owner = session.apps.find((a: { app: string }) => a.app === "mcp")
    .identity.id;
  const metrics = await (await request.get(`${simulator}/metrics`)).json();
  for (const [name, bytes] of inputs)
    expect(
      metrics.files.find(
        (f: { name: string; owner: string }) =>
          f.name === name && f.owner === owner,
      ),
    ).toMatchObject({
      size: bytes.length,
      sha1: createHash("sha1").update(bytes).digest("hex"),
    });
  expect(metrics.hostedCalls).toContain("upload_file");
  expect(metrics.hostedCalls).toContain("get_upload_url");
});
