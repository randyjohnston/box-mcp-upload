import { defineConfig } from "@playwright/test";
const env = {
  BOX_MCP_CLIENT_ID: "",
  BOX_MCP_CLIENT_SECRET: "",
  BOX_CCG_USER_ID: "",
  BOX_USER_ROOT_FOLDER_ID: "0",
  BOX_E2E: "1",
  BOX_TEST_ORIGIN: "http://127.0.0.1:3130",
  BOX_CCG_CLIENT_ID: "ccg-client",
  BOX_CCG_CLIENT_SECRET: "ccg-secret",
  BOX_CCG_ENTERPRISE_ID: "123",
  BOX_OAUTH_CLIENT_ID: "oauth-client",
  BOX_OAUTH_CLIENT_SECRET: "oauth-secret",
  BOX_CCG_ROOT_FOLDER_ID: "0",
  MAX_UPLOAD_BYTES: "33554432",
};
export default defineConfig({
  testDir: "./tests",
  testMatch: "*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: "list",
  use: { browserName: "chromium", trace: "retain-on-failure" },
  projects: [
    { name: "ccg", use: { baseURL: "http://127.0.0.1:3100" } },
    { name: "oauth", use: { baseURL: "http://127.0.0.1:3101" } },
    { name: "mcp", use: { baseURL: "http://127.0.0.1:3102" } },
  ],
  webServer: [
    {
      command: "npx tsx tests/box-simulator.ts",
      url: "http://127.0.0.1:3130/health",
      reuseExistingServer: false,
    },
    ...(["ccg", "oauth", "mcp"] as const).map((mode, index) => ({
      command: `npx next start -H 127.0.0.1 -p ${3100 + index}`,
      url: `http://127.0.0.1:${3100 + index}`,
      env: {
        ...env,
        // All credentials are explicit test values; .env cannot enable a live path.
        ...(mode === "mcp"
          ? {
              BOX_MCP_CLIENT_ID: "mcp-client",
              BOX_MCP_CLIENT_SECRET: "mcp-secret",
            }
          : {}),
        APP_ORIGIN: `http://127.0.0.1:${3100 + index}`,
        APP_ACCESS_PASSWORD: "",
        STAGING_DIR: `/tmp/box-e2e-${mode}`,
      },
      reuseExistingServer: false,
    })),
  ],
});
