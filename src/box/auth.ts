import { tracedFetch } from "../telemetry";
import { z } from "zod";
import { HttpError } from "../errors";
import {
  AUTH_APP_LABEL,
  boxConfig,
  boxEndpoints,
  type AuthApp,
} from "./config";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  restricted_to: z
    .array(
      z.object({
        scope: z.string(),
        object: z.object({ id: z.string(), type: z.string() }),
      }),
    )
    .optional(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
});
export type Token = {
  restrictedTo?: { scope: string; object: { id: string; type: string } }[];
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
};
export type TokenProvider = {
  app?: AuthApp;
  getAccessToken: (rejectedToken?: string) => Promise<string>;
  revoke: () => Promise<void>;
};

/** `app` selects which OAuth application's credentials sign the request. */
export async function requestToken(
  parameters: Record<string, string>,
  app?: AuthApp,
): Promise<Token> {
  const cfg = boxConfig(app);
  const res = await tracedFetch(
    boxEndpoints().token,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...parameters,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
    },
    parameters.grant_type === "urn:ietf:params:oauth:grant-type:token-exchange"
      ? "Downscope · base_upload"
      : `Token · ${parameters.grant_type}`,
    "Next.js server → Box OAuth",
    AUTH_APP_LABEL[app ?? (cfg.mode === "ccg" ? "ccg" : cfg.oauthApp)],
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = [
      "unauthorized_client",
      "invalid_client",
      "invalid_grant",
      "invalid_request",
      "invalid_scope",
      "unsupported_grant_type",
    ].includes(body.error)
      ? ` (${body.error})`
      : "";
    throw new HttpError(
      res.status === 400 || res.status === 401 ? 401 : 502,
      `Box authentication failed${code}. Check configuration or reconnect your account.`,
    );
  }
  const token = tokenSchema.parse(await res.json());
  return {
    restrictedTo: token.restricted_to,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt:
      Date.now() +
      token.expires_in * 1000 -
      Math.min(60_000, token.expires_in * 100),
  };
}

export function tokenProvider(initial?: Token, app?: AuthApp): TokenProvider {
  const config = boxConfig(app);
  const oauth = config.mode === "oauth";
  app = oauth ? config.oauthApp : "ccg";
  let cached = initial;
  let inFlight: Promise<Token> | undefined;
  let revoked = false;
  return {
    app,
    async getAccessToken(rejectedToken) {
      if (revoked)
        throw new HttpError(401, "Please reconnect your Box account.");
      if (
        cached &&
        cached.accessToken !== rejectedToken &&
        Date.now() < cached.expiresAt
      )
        return cached.accessToken;
      if (!inFlight) {
        const cfg = boxConfig(app);
        if (oauth && !cached?.refreshToken)
          throw new HttpError(401, "Please connect your Box account.");
        inFlight = requestToken(
          oauth
            ? {
                grant_type: "refresh_token",
                refresh_token: cached!.refreshToken!,
              }
            : {
                grant_type: "client_credentials",
                box_subject_type: cfg.subjectType,
                box_subject_id: cfg.subjectId,
              },
          app,
        )
          .then((token) => {
            if (oauth && !token.refreshToken)
              throw new HttpError(
                401,
                "Box did not return a refresh token. Reconnect your account.",
              );
            cached = token;
            return token;
          })
          .catch((error) => {
            // A rotating refresh token cannot safely be replayed after an ambiguous failure.
            if (oauth) cached = undefined;
            throw error;
          })
          .finally(() => {
            inFlight = undefined;
          });
      }
      const token = await inFlight;
      if (revoked)
        throw new HttpError(401, "Please reconnect your Box account.");
      return token.accessToken;
    },
    async revoke() {
      revoked = true;
      await inFlight?.catch(() => undefined);
      const token = cached;
      cached = undefined;
      if (!oauth || !token) return;
      const cfg = boxConfig(app);
      const response = await tracedFetch(
        boxEndpoints().revoke,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          body: new URLSearchParams({
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            token: token.accessToken,
          }),
        },
        "Token revocation",
        "Next.js server → Box OAuth",
        AUTH_APP_LABEL[app ?? "ccg"],
      );
      if (!response.ok)
        throw new HttpError(
          502,
          "Signed out locally; Box token revocation failed.",
        );
    },
  };
}
