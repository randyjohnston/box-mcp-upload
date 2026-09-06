import { currentRequests } from "../telemetry";
import type { RequestEvent } from "../request-event";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  defaultAuthApp,
  appOrigin,
  boxConfig,
  boxEndpoints,
  isLoopback,
  oauthAppConfigured,
  type OAuthApp,
  type AuthApp,
} from "../box/config";
import { tokenProvider, requestToken, type TokenProvider } from "../box/auth";
import { BoxClient } from "../box/client";
import { whoAmI } from "../box/folders";
import { HttpError } from "../errors";

const SESSION_TTL = 8 * 60 * 60 * 1000;
const STATE_TTL = 10 * 60 * 1000;
const SESSION_COOKIE = "box_session";
const STATE_COOKIE = "box_oauth_state";
export type Credential = {
  app: AuthApp;
  auth: TokenProvider;
  clientId: string;
  mode: "ccg" | "oauth";
  /** Who this credential actually authenticates as, resolved once on connect. */
  identity?: { id: string; name: string; login: string };
};
/**
 * A session can hold more than one credential at a time. That is the whole
 * point of the fallback setup: sign in to the MCP integration *and* a platform
 * flow, so that when Box refuses the MCP app (permissions or CORS) the other
 * credential is already available without a second round of consent.
 */
type Session = {
  authEvents: RequestEvent[];
  id: string;
  expiresAt: number;
  credentials: Map<AuthApp, Credential>;
};
type Pending = { verifier: string; expiresAt: number; app: OAuthApp };

// Single-instance local store. Replace with a shared store before deploying (docs/deployment.md).
const globalStore = globalThis as typeof globalThis & {
  boxSessions?: {
    sessions: Map<string, Session>;
    pending: Map<string, Pending>;
    attempts: number[];
  };
};
const store: NonNullable<typeof globalStore.boxSessions> =
  (globalStore.boxSessions ??= {
    sessions: new Map(),
    pending: new Map(),
    attempts: [],
  });

function prune() {
  for (const map of [store.sessions, store.pending]) {
    for (const [id, entry] of map)
      if (entry.expiresAt <= Date.now()) map.delete(id);
  }
}
function cookie(
  response: NextResponse,
  name: string,
  value: string,
  maxAge: number,
) {
  response.cookies.set(name, value, {
    httpOnly: true,
    secure: appOrigin().startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge,
  });
}
function cookieValue(req: Request, name: string) {
  return new NextRequest(req.url, { headers: req.headers }).cookies.get(name)
    ?.value;
}
/**
 * Adds (or replaces) one app's credential, keeping any other already held.
 * Connecting a second app arms the fallback rather than signing the first out.
 */
async function attachCredential(
  req: Request,
  response: NextResponse,
  app: AuthApp,
  auth: TokenProvider,
) {
  prune();
  const cfg = boxConfig(app);
  const existing = getSession(req);
  if (!existing && store.sessions.size >= 1000)
    throw new HttpError(
      503,
      "Session capacity reached. Please try again later.",
    );
  const session: Session = existing ?? {
    id: randomBytes(32).toString("base64url"),
    credentials: new Map(),
    authEvents: [],
    expiresAt: Date.now() + SESSION_TTL,
  };
  // Replacing the same app releases its token. So does switching between the
  // two platform flows, which are alternatives rather than a pair.
  const exclusive: AuthApp[] =
    app === "mcp" ? ["mcp"] : ["platform", "ccg"];
  for (const key of exclusive) {
    const replaced = session.credentials.get(key);
    if (!replaced) continue;
    session.credentials.delete(key);
    if (replaced.mode === "oauth")
      await replaced.auth.revoke().catch(() => undefined);
  }
  const credential: Credential = {
    app,
    auth,
    clientId: cfg.clientId,
    mode: cfg.mode,
  };
  session.credentials.set(app, credential);
  // Resolve the Box account once here rather than on every session poll. A
  // failure must not block sign-in: the credential still works without a name.
  credential.identity = await whoAmI(new BoxClient(auth)).catch(() => undefined);
  session.authEvents = currentRequests();
  session.expiresAt = Date.now() + SESSION_TTL;
  store.sessions.set(session.id, session);
  cookie(response, SESSION_COOKIE, session.id, SESSION_TTL / 1000);
}

/** MCP takes precedence whenever it is connected. */
export function primaryApp(session: Session): AuthApp | undefined {
  if (session.credentials.has("mcp")) return "mcp";
  return [...session.credentials.keys()][0];
}
/** The other connected credential, used when the primary one is refused. */
export function fallbackApp(session: Session): AuthApp | undefined {
  const primary = primaryApp(session);
  return [...session.credentials.keys()].find((app) => app !== primary);
}
export function connectedApps(session?: Session): AuthApp[] {
  return session ? [...session.credentials.keys()] : [];
}
export function credentialFor(session: Session, app?: AuthApp): Credential {
  const key = app ?? primaryApp(session);
  const credential = key ? session.credentials.get(key) : undefined;
  if (!credential) throw new HttpError(401, "Please connect to continue.");
  return credential;
}
export function getSession(req: Request): Session | undefined {
  prune();
  const session = store.sessions.get(cookieValue(req, SESSION_COOKIE) ?? "");
  if (!session) return undefined;
  // Each credential is bound to the app that issued it. If configuration now
  // names a different client for that app, that token no longer applies —
  // drop it, but keep any credential that is still valid.
  for (const [app, credential] of session.credentials) {
    const cfg = boxConfig(app);
    if (credential.clientId !== cfg.clientId || credential.mode !== cfg.mode)
      session.credentials.delete(app);
  }
  return session.credentials.size ? session : undefined;
}
export function requireSession(req: Request): Session {
  const session = getSession(req);
  if (!session) throw new HttpError(401, "Please connect to continue.");
  return session;
}
export function passwordRequired() {
  const password = process.env.APP_ACCESS_PASSWORD;
  if (
    !isLoopback(new URL(appOrigin())) &&
    (!password || password.length < 16)
  ) {
    throw new Error(
      "Remote CCG access requires APP_ACCESS_PASSWORD with at least 16 characters.",
    );
  }
  return Boolean(password);
}

export async function login(req: Request): Promise<NextResponse> {
  prune();
  const body = await req.json().catch(() => ({}));
  if (body?.app !== undefined && !["mcp", "platform", "ccg"].includes(body.app))
    throw new HttpError(400, "Unknown application.");
  const app: AuthApp = body?.app ?? defaultAuthApp();
  if (app !== "ccg" && !oauthAppConfigured(app))
    throw new HttpError(400, "The selected application is not configured.");
  if (app !== "ccg") {
    if (store.pending.size >= 1000)
      throw new HttpError(429, "Too many pending sign-ins. Try again later.");
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const previous = cookieValue(req, STATE_COOKIE);
    if (previous) store.pending.delete(previous);
    store.pending.set(state, {
      verifier,
      app,
      expiresAt: Date.now() + STATE_TTL,
    });
    const url = new URL(boxEndpoints().authorize);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: boxConfig(app).clientId,
      redirect_uri: `${appOrigin()}/api/auth/callback`,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    const response = NextResponse.json({ url: url.href, app });
    cookie(response, STATE_COOKIE, state, STATE_TTL / 1000);
    return response;
  }
  if (passwordRequired()) {
    store.attempts = store.attempts.filter(
      (time) => time > Date.now() - 60_000,
    );
    if (store.attempts.length >= 10)
      throw new HttpError(429, "Too many sign-in attempts. Wait a minute.");
    store.attempts.push(Date.now());
    const input = body ?? {};
    const hash = (value: string) => createHash("sha256").update(value).digest();
    if (
      typeof input.password !== "string" ||
      !timingSafeEqual(
        hash(input.password),
        hash(process.env.APP_ACCESS_PASSWORD!),
      )
    ) {
      throw new HttpError(401, "Incorrect access password.");
    }
  }
  const auth = tokenProvider(undefined, "ccg");
  await auth.getAccessToken();
  const response = NextResponse.json({ connected: true, app: "ccg" });
  const pendingState = cookieValue(req, STATE_COOKIE);
  if (pendingState) store.pending.delete(pendingState);
  cookie(response, STATE_COOKIE, "", 0);
  await attachCredential(req, response, "ccg", auth);
  return response;
}

export async function callback(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const stored = cookieValue(req, STATE_COOKIE);
  prune();
  const pending = stored ? store.pending.get(stored) : undefined;
  if (!state || state !== stored || !pending)
    throw new HttpError(
      400,
      "Sign-in expired or could not be verified. Please reconnect.",
    );
  store.pending.delete(state); // Consume before exchanging the code; replay cannot race the token request.
  const code = url.searchParams.get("code");
  if (url.searchParams.has("error") || !code || code.length > 2048)
    throw new HttpError(
      400,
      "Box sign-in was not completed. Please reconnect.",
    );
  const token = await requestToken(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: `${appOrigin()}/api/auth/callback`,
      code_verifier: pending.verifier,
    },
    pending.app,
  );
  if (!token.refreshToken)
    throw new HttpError(502, "Box did not return a refresh token.");
  const response = NextResponse.redirect(new URL("/", appOrigin()), 303);
  await attachCredential(
    req,
    response,
    pending.app,
    tokenProvider(token, pending.app),
  );
  cookie(response, STATE_COOKIE, "", 0);
  return response;
}

export async function logout(req: Request): Promise<NextResponse> {
  const session = getSession(req);
  if (session) store.sessions.delete(session.id);
  const state = cookieValue(req, STATE_COOKIE);
  if (state) store.pending.delete(state);
  const response = NextResponse.json({ connected: false });
  cookie(response, SESSION_COOKIE, "", 0);
  cookie(response, STATE_COOKIE, "", 0);
  for (const credential of session?.credentials.values() ?? []) {
    if (credential.mode !== "oauth") continue;
    try {
      await credential.auth.revoke();
    } catch {
      /* Local sign-out remains effective if Box is unavailable. */
    }
  }
  return response;
}
