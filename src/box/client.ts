import { tracedFetch } from "../telemetry";
import { HttpError } from "../errors";
import { AUTH_APP_LABEL, boxConfig, boxEndpoints } from "./config";
import type { TokenProvider } from "./auth";

export class BoxApiError extends HttpError {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly conflictId?: string,
    readonly conflictType?: string,
  ) {
    super(status, `Box API request failed (HTTP ${status}).`);
  }
}

async function toError(res: Response): Promise<BoxApiError> {
  const body = await res.json().catch(() => ({}));
  const conflicts = body.context_info?.conflicts;
  const conflict = Array.isArray(conflicts) ? conflicts[0] : conflicts;
  return new BoxApiError(
    res.status,
    typeof body.code === "string" ? body.code : undefined,
    /^\d+$/.test(conflict?.id) ? conflict.id : undefined,
    conflict?.type,
  );
}

export function retryDelayMs(res: Response, attempt: number): number {
  const value = res.headers.get("retry-after");
  const seconds = value ? Number(value) : NaN;
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : value
      ? Date.parse(value) - Date.now()
      : NaN;
  return Math.min(
    30_000,
    Math.max(0, Number.isFinite(delay) ? delay : 250 * 2 ** attempt),
  );
}
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Only Box API and regional upload hosts may receive bearer tokens. */
function isTrustedBoxTarget(
  target: URL,
  endpoints: ReturnType<typeof boxEndpoints>,
): boolean {
  if (target.username || target.password) return false;
  const configured = [endpoints.api, endpoints.upload, endpoints.token].map(
    (value) => new URL(value).origin,
  );
  if (configured.includes(target.origin)) return true;
  return (
    target.protocol === "https:" &&
    !target.port &&
    /^upload(?:-[a-z0-9-]+)?(?:\.(?:app|ent))?\.box\.com$/.test(target.hostname)
  );
}

export class BoxClient {
  constructor(private readonly auth: TokenProvider) {}
  get rootFolderId() {
    return boxConfig(this.auth.app).rootFolderId;
  }
  get uploadUrl() {
    return boxEndpoints().upload;
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const endpoints = boxEndpoints();
    const target = new URL(
      url.startsWith("/") ? `${endpoints.api}${url}` : url,
    );
    if (!isTrustedBoxTarget(target, endpoints))
      throw new Error("Untrusted Box API endpoint.");
    const retrySafe = ["GET", "PUT", "DELETE"].includes(init.method ?? "GET");
    let rejectedToken: string | undefined;
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.getAccessToken(rejectedToken);
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      let res: Response;
      try {
        res = await tracedFetch(
          target,
          {
            ...init,
            headers,
            redirect: "error",
            signal: init.signal ?? AbortSignal.timeout(60_000),
          },
          undefined,
          undefined,
          this.auth.app ? AUTH_APP_LABEL[this.auth.app] : undefined,
        );
      } catch (error) {
        if (!retrySafe || attempt >= 3 || init.signal?.aborted) throw error;
        await sleep(250 * 2 ** attempt);
        continue;
      }
      if (res.ok) return res;
      if (res.status === 401 && !rejectedToken) {
        rejectedToken = token;
        await res.body?.cancel();
        continue;
      }
      // POSTs may have succeeded before a 5xx: never repeat an uncertain write.
      if (
        attempt < 3 &&
        (res.status === 429 || (retrySafe && res.status >= 500))
      ) {
        const delay = retryDelayMs(res, attempt);
        await res.body?.cancel();
        await sleep(delay);
        continue;
      }
      throw await toError(res);
    }
  }
  async json<T>(url: string, init?: RequestInit): Promise<T> {
    return (await this.fetch(url, init)).json() as Promise<T>;
  }
}
