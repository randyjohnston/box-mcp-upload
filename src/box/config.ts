import { z } from "zod";

const schema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  BOX_CCG_ENTERPRISE_ID: z.string().optional(),
  BOX_CCG_USER_ID: z.string().optional(),
  // Two different Box trees: a signed-in user's, and the service account's.
  BOX_USER_ROOT_FOLDER_ID: z.string().regex(/^\d+$/).default("0"),
  BOX_CCG_ROOT_FOLDER_ID: z.string().regex(/^\d+$/).default("0"),
});

export type OAuthApp = "mcp" | "platform";
/** One label per registration, shared by the server trace and the UI. */
export const AUTH_APP_LABEL = {
  mcp: "MCP integration",
  platform: "Platform OAuth",
  ccg: "Platform CCG",
} as const;
export type AuthApp = OAuthApp | "ccg";
const APPS: AuthApp[] = ["mcp", "platform", "ccg"];

export function appConfigured(app: AuthApp): boolean {
  if (app !== "ccg") return oauthAppConfigured(app);
  return Boolean(
    process.env.BOX_CCG_CLIENT_ID && process.env.BOX_CCG_CLIENT_SECRET,
  );
}

/**
 * Which Box app the UI selects on load: the first configured one, in
 * precedence order. Nothing to configure — the MCP integration wins whenever
 * it is set up, and any configured app can still be chosen in the UI.
 */
export function defaultAuthApp(): AuthApp {
  return APPS.find(appConfigured) ?? "mcp";
}

function oauthCredentials(app: OAuthApp) {
  return app === "mcp"
    ? {
        clientId: process.env.BOX_MCP_CLIENT_ID,
        clientSecret: process.env.BOX_MCP_CLIENT_SECRET,
      }
    : {
        clientId: process.env.BOX_OAUTH_CLIENT_ID,
        clientSecret: process.env.BOX_OAUTH_CLIENT_SECRET,
      };
}

export function oauthAppConfigured(app: OAuthApp): boolean {
  const { clientId, clientSecret } = oauthCredentials(app);
  return Boolean(clientId && clientSecret);
}

export function preferredOAuthApp(): OAuthApp {
  return oauthAppConfigured("mcp") ? "mcp" : "platform";
}

export const otherOAuthApp = (app: OAuthApp): OAuthApp =>
  app === "mcp" ? "platform" : "mcp";

/** The preferred app, or the other one when the preferred is not configured. */
export function activeOAuthApp(): OAuthApp {
  const preferred = preferredOAuthApp();
  if (oauthAppConfigured(preferred)) return preferred;
  // Fall through to the configured alternative; if neither is set, keep the
  // preferred one so boxConfig reports which credentials are missing.
  return oauthAppConfigured(otherOAuthApp(preferred))
    ? otherOAuthApp(preferred)
    : preferred;
}

/** The app to retry with when `app` cannot reach Box from the browser. */
export function fallbackOAuthApp(app: OAuthApp): OAuthApp | undefined {
  return oauthAppConfigured(otherOAuthApp(app))
    ? otherOAuthApp(app)
    : undefined;
}

export function boxConfig(app: AuthApp = defaultAuthApp()) {
  const selected = app === "ccg" ? undefined : app;
  const credentials = selected ? oauthCredentials(selected) : undefined;
  const parsed = schema.safeParse({
    ...process.env,
    clientId: credentials ? credentials.clientId : process.env.BOX_CCG_CLIENT_ID,
    clientSecret: credentials
      ? credentials.clientSecret
      : process.env.BOX_CCG_CLIENT_SECRET,
  });
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const env = parsed.data;
  const mode: "ccg" | "oauth" = selected ? "oauth" : "ccg";
  // A user id means "act as that user"; otherwise the token is the
  // enterprise's own service account.
  const subjectType = env.BOX_CCG_USER_ID ? "user" : "enterprise";
  const subjectId = env.BOX_CCG_USER_ID ?? env.BOX_CCG_ENTERPRISE_ID;
  if (mode === "ccg" && !/^\d+$/.test(subjectId ?? "")) {
    throw new Error(
      "Invalid configuration: CCG requires BOX_CCG_ENTERPRISE_ID, or BOX_CCG_USER_ID to act as one user.",
    );
  }
  return {
    mode,
    oauthApp: selected ?? preferredOAuthApp(),
    clientId: env.clientId,
    clientSecret: env.clientSecret,
    subjectType,
    subjectId: subjectId ?? "",
    rootFolderId:
      mode === "oauth"
        ? env.BOX_USER_ROOT_FOLDER_ID
        : env.BOX_CCG_ROOT_FOLDER_ID,
  };
}

export function appOrigin(): string {
  const url = new URL(process.env.APP_ORIGIN || "http://127.0.0.1:3000");
  if (
    url.username ||
    url.password ||
    url.origin !== url.href.replace(/\/$/, "") ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url)))
  ) {
    throw new Error(
      "APP_ORIGIN must be an HTTPS origin (HTTP is allowed on loopback only).",
    );
  }
  return url.origin;
}

export function isLoopback(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

// Test endpoints are deliberately limited to loopback and disabled on Vercel.
export function boxEndpoints() {
  const mock = process.env.BOX_TEST_ORIGIN;
  if (mock) {
    const url = new URL(mock);
    if (
      process.env.VERCEL ||
      process.env.BOX_E2E !== "1" ||
      !isLoopback(url) ||
      url.protocol !== "http:"
    ) {
      throw new Error(
        "BOX_TEST_ORIGIN is only allowed for local BOX_E2E=1 tests.",
      );
    }
    return {
      api: `${url.origin}/2.0`,
      upload: `${url.origin}/api/2.0`,
      token: `${url.origin}/oauth2/token`,
      authorize: `${url.origin}/authorize`,
      revoke: `${url.origin}/oauth2/revoke`,
    };
  }
  return {
    api: "https://api.box.com/2.0",
    upload: "https://upload.box.com/api/2.0",
    token: "https://api.box.com/oauth2/token",
    authorize: "https://account.box.com/api/oauth2/authorize",
    revoke: "https://api.box.com/oauth2/revoke",
  };
}
