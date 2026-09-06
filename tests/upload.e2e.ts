import { test, expect, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";

const connectButton = (page: Page) =>
  page.getByRole("button", {
    name: /^(Connect Platform CCG|Sign in with platform app)$/,
  });
async function connect(page: Page) {
  await page.goto("/");
  await expect(connectButton(page)).toBeEnabled();
  const password = page.getByLabel("Access password");
  if (await password.isVisible())
    await password.fill("test-workspace-password");
  await connectButton(page).click();
  await expect(page.getByText(/^Box connected/)).toBeVisible();
}
async function choose(page: Page, name: string, buffer: Buffer) {
  await page
    .getByLabel("Choose files")
    .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
}

for (const fallback of [false, true]) {
  test(`${fallback ? "network fallback" : "direct"}: simple, chunked, versions and hashes`, async ({
    page,
    request,
  }, info) => {
    await connect(page);
    const folder = `e2e-${info.project.name}-${fallback}-${Date.now()}`;
    await page.getByLabel("Destination folder").fill(folder);
    let stages = 0;
    page.on("request", (req) => {
      if (req.url().endsWith("/api/uploads")) stages++;
    });
    if (fallback)
      await page.route("http://127.0.0.1:3130/**", (route) =>
        route.abort("blockedbyclient"),
      );
    let transferCount = 0;
    for (const size of [2048, 21 * 1024 ** 2]) {
      const name = `file-${size}-${Date.now()}.bin`;
      const buffer = randomBytes(size);
      for (let version = 1; version <= 2; version++) {
        await choose(page, name, buffer);
        await expect(page.locator(".transfer")).toHaveCount(++transferCount);
        await expect(
          page
            .locator(".transfer")
            .last()
            .getByText(
              `Saved to Box · ${fallback ? "Server fallback" : "Direct"}${version === 2 ? " · New version" : ""}`,
              { exact: true },
            )
            .last(),
        ).toBeVisible({ timeout: 60_000 });
        await expect(
          page.getByRole("link", { name, exact: true }),
        ).toBeVisible();
      }
      const metrics = await (
        await request.get("http://127.0.0.1:3130/metrics")
      ).json();
      const file = metrics.files.find(
        (file: { name: string }) => file.name === name,
      );
      expect(file).toMatchObject({
        size,
        version: 2,
        sha1: createHash("sha1").update(buffer).digest("hex"),
      });
    }
    expect(stages).toBe(fallback ? 4 : 0);
    await page.screenshot({
      path: `test-results/${info.project.name}-${fallback ? "fallback" : "direct"}.png`,
      fullPage: true,
    });
  });
}

test("HTTP permission failures do not trigger fallback", async ({ page }) => {
  await connect(page);
  await page.route("http://127.0.0.1:3130/**", (route) =>
    route.fulfill({
      status: 403,
      headers: { "Access-Control-Allow-Origin": new URL(page.url()).origin },
      body: "{}",
    }),
  );
  let staged = false;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/uploads")) staged = true;
  });
  await choose(page, `denied-${Date.now()}.bin`, Buffer.alloc(2048));
  await expect(
    page.getByRole("alert").filter({ hasText: "HTTP 403" }),
  ).toBeVisible();
  expect(staged).toBe(false);
});

test("authentication, CSRF, validation and upload ownership", async ({
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
  const context = page.context();
  const headers = { Origin: baseURL!, "x-file-name": "test.bin" };
  expect(
    (
      await context.request.post("/api/uploads", {
        headers: { ...headers, Origin: "https://evil.example" },
        data: "x",
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await context.request.post("/api/uploads", {
        headers: { ...headers, "x-file-name": "%GG" },
        data: "x",
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await context.request.post("/api/uploads", {
        headers: { ...headers, "x-file-name": "..%2Fsecret" },
        data: "x",
      })
    ).status(),
  ).toBe(400);
  const staged = await (
    await context.request.post("/api/uploads", { headers, data: "owned" })
  ).json();
  const other = await browser.newContext({ baseURL });
  const otherPage = await other.newPage();
  await connect(otherPage);
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
      await context.request.post(`/api/uploads/${staged.uploadId}/commit`, {
        headers,
        data: { folder: 42 },
      })
    ).status(),
  ).toBe(400);
  const committed = await context.request.post(
    `/api/uploads/${staged.uploadId}/commit`,
    { headers, data: {} },
  );
  expect(await committed.text()).toContain("event: done");
  expect(
    (
      await context.request.post(`/api/uploads/${staged.uploadId}/commit`, {
        headers,
        data: {},
      })
    ).status(),
  ).toBe(404);
  const cookies = await context.cookies();
  expect(cookies.find((cookie) => cookie.name === "box_session")).toMatchObject(
    { httpOnly: true, sameSite: "Lax" },
  );
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(connectButton(page)).toBeVisible();
  expect((await context.request.get("/api/files")).status()).toBe(401);
});

test("refresh is isolated and concurrent calls share renewal", async ({
  page,
  request,
}, info) => {
  await connect(page);
  await page.waitForTimeout(500);
  const before = await (
    await request.get("http://127.0.0.1:3130/metrics")
  ).json();
  await request.post("http://127.0.0.1:3130/expire");
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => page.context().request.get("/api/files")),
  );
  expect(responses.every((response) => response.ok())).toBe(true);
  const after = await (
    await request.get("http://127.0.0.1:3130/metrics")
  ).json();
  const field = info.project.name === "oauth" ? "refresh" : "ccg";
  expect(after[field] - before[field]).toBe(1);
});

test("OAuth state is required, single-use and bound to the browser", async ({
  page,
  request,
  baseURL,
}, info) => {
  test.skip(info.project.name !== "oauth");
  expect(
    (await request.get("/api/auth/callback?code=fake&state=fake")).status(),
  ).toBe(400);
  const login = await (
    await request.post("/api/auth/login", {
      headers: { Origin: baseURL! },
      data: {},
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

test("responsive UI and upload validation", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await connect(page);
  await choose(page, "empty.txt", Buffer.alloc(0));
  await expect(
    page.getByRole("alert").filter({ hasText: "non-empty" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/${info.project.name}-mobile.png`,
    fullPage: true,
  });
});

test("OAuth app selection and per-request credential trace", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "oauth");
  await connect(page);
  await expect(
    page.locator('.provider-card[data-selected="true"]'),
  ).toContainText("Platform app");
  await page
    .getByRole("button", { name: "Sign in with MCP integration", exact: true })
    .click();
  await expect(
    page.locator('.provider-card[data-selected="true"]'),
  ).toContainText("Custom MCP integration");
  await expect(page.getByText(/^Box connected/)).toContainText(
    "MCP integration",
  );
  await choose(page, `mcp-${Date.now()}.bin`, Buffer.alloc(2048));
  await expect(page.locator(".transfer-status").last()).toContainText(
    "Saved to Box · Direct",
  );
  const trace = page.getByRole("region", { name: /Request trace/ });
  await expect(trace).toContainText("MCP integration");
  await expect(trace).toContainText("Downscope · base_upload");
  await expect(trace).toContainText("Browser → Box API");
  await expect(trace).not.toContainText("mcp-secret");
  await page
    .getByRole("button", { name: "Sign in with platform app", exact: true })
    .click();
  await expect(
    page.locator('.provider-card[data-selected="true"]'),
  ).toContainText("Platform app");
  await expect(trace).toContainText("MCP integration");
  await expect(trace).toContainText("Token revocation");
});

test("disabling fallback stops on a browser network failure", async ({
  page,
}) => {
  await connect(page);
  await page.getByLabel("Allow server fallback").uncheck();
  await page.route("http://127.0.0.1:3130/**", (route) =>
    route.abort("blockedbyclient"),
  );
  let stages = 0;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/uploads")) stages++;
  });
  await choose(page, `direct-only-${Date.now()}.bin`, Buffer.alloc(2048));
  await expect(page.locator(".transfer-status").last()).toContainText(
    "could not reach Box",
  );
  expect(stages).toBe(0);
  await expect(
    page.getByRole("region", { name: /Request trace/ }),
  ).toContainText("CORS / blocked");
});

test("platform selector switches CCG and OAuth with one active session", async ({
  page,
  request,
  baseURL,
}) => {
  await connect(page);
  await page.getByLabel("Platform auth flow").selectOption("ccg");
  if (
    await page
      .getByRole("button", { name: "Connect Platform CCG", exact: true })
      .isVisible()
  ) {
    const password = page.getByLabel("Access password");
    if (await password.isVisible())
      await password.fill("test-workspace-password");
    await page
      .getByRole("button", { name: "Connect Platform CCG", exact: true })
      .click();
  }
  await expect(page.getByText(/^Box connected/)).toContainText("Platform CCG");
  const previousCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "box_session",
  )!;
  await page.getByLabel("Platform auth flow").selectOption("platform");
  await expect(page.getByText(/^Box connected/)).toContainText("Platform CCG");
  await page
    .getByRole("button", { name: "Sign in with platform app", exact: true })
    .click();
  await expect(page.getByText(/^Box connected/)).toContainText(
    "Platform OAuth",
  );
  const status = await (
    await page.context().request.get("/api/auth/session")
  ).json();
  expect(status).toMatchObject({
    mode: "oauth",
    app: "platform",
    connected: true,
  });
  expect(
    (
      await request.get(`${baseURL}/api/files`, {
        headers: { Cookie: `box_session=${previousCookie.value}` },
      })
    ).status(),
  ).toBe(401);
  await choose(page, `after-switch-${Date.now()}.bin`, Buffer.alloc(2048));
  await expect(page.locator(".transfer-status").last()).toContainText(
    "Saved to Box · Direct",
  );
});
