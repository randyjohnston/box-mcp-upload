import {
  connectedApps,
  credentialFor,
  fallbackApp,
  getSession,
  primaryApp,
} from "@/auth/session";
import {
  appOrigin,
  boxConfig,
  defaultAuthApp,
  oauthAppConfigured,
  preferredOAuthApp,
  type AuthApp,
} from "@/box/config";
import { errorResponse, maxUploadBytes } from "@/http";
export const runtime = "nodejs";

const ccgConfigured = () =>
  Boolean(process.env.BOX_CCG_CLIENT_ID && process.env.BOX_CCG_CLIENT_SECRET);

export async function GET(req: Request) {
  try {
    const session = getSession(req);
    const connected = connectedApps(session);
    const primary = session ? primaryApp(session) : undefined;
    const fallback = session ? fallbackApp(session) : undefined;

    const apps = (["mcp", "platform", "ccg"] as AuthApp[]).map((app) => ({
      app,
      configured: app === "ccg" ? ccgConfigured() : oauthAppConfigured(app),
      connected: connected.includes(app),
      role:
        app === primary ? "primary" : app === fallback ? "fallback" : undefined,
      clientId:
        app === "ccg"
          ? process.env.BOX_CCG_CLIENT_ID
          : app === "mcp"
            ? process.env.BOX_MCP_CLIENT_ID
            : process.env.BOX_OAUTH_CLIENT_ID,
      identity:
        session && connected.includes(app)
          ? credentialFor(session, app).identity
          : undefined,
    }));

    return Response.json(
      {
        origin: appOrigin(),
        // Where uploads are rooted for the active credential.
        rootFolderId: boxConfig(primary ?? defaultAuthApp()).rootFolderId,
        maxUploadBytes: maxUploadBytes(),
        connected: Boolean(session),
        apps,
        primaryApp: primary,
        fallbackApp: fallback,
        // The fallback is only usable when a *second* credential is already
        // held: switching apps otherwise needs a fresh round of consent.
        fallbackArmed: Boolean(primary && fallback),
        defaultApp: defaultAuthApp(),
        preferredApp: preferredOAuthApp(),
        mode: primary
          ? boxConfig(primary).mode
          : defaultAuthApp() === "ccg"
            ? "ccg"
            : "oauth",
        ccg: {
          configured: ccgConfigured(),
          passwordRequired: Boolean(process.env.APP_ACCESS_PASSWORD),
          subjectType: process.env.BOX_CCG_USER_ID ? "user" : "enterprise",
          subjectId:
            process.env.BOX_CCG_USER_ID ?? process.env.BOX_CCG_ENTERPRISE_ID,
        },
        authEvents: session?.authEvents ?? [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
