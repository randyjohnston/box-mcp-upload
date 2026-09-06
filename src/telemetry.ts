import { AsyncLocalStorage } from "node:async_hooks";
import { HttpError, publicError } from "./errors";
import type { RequestEvent } from "./request-event";

const context = new AsyncLocalStorage<{
  requests: RequestEvent[];
  step: string;
  emit?: (event: RequestEvent) => void;
}>();
export function currentRequests() {
  return [...(context.getStore()?.requests ?? [])];
}

export async function traceRequests<T>(
  step: string,
  action: () => Promise<T>,
  emit?: (event: RequestEvent) => void,
) {
  const requests: RequestEvent[] = [];
  try {
    const value = await context.run({ requests, step, emit }, action);
    return { value, requests };
  } catch (error) {
    const failure =
      error instanceof HttpError
        ? error
        : new HttpError(502, publicError(error));
    failure.requests = requests;
    throw failure;
  }
}

/** Plain-language routing decision for a server-side Box call. */
function describe(step: string, status?: number): string {
  // Only calls issued by an MCP tool should claim to be one; token and
  // identity calls are the Next.js server authenticating on its own behalf.
  const who = step.startsWith("box_")
    ? `MCP tool ${step} → Box REST API`
    : `${step}: not an MCP tool`;
  const where =
    " · always runs on the Next.js server, which holds the Box credential";
  // 409 is not a failure here: it is how an existing folder or file is found
  // so it can be reused or versioned.
  const conflict =
    status === 409
      ? " · 409 is expected: the name already exists, so the existing item is reused"
      : "";
  return `${who}${where}${conflict}`;
}

// Deliberately excludes query strings, headers, bodies, cookies, and tokens.
export async function tracedFetch(
  input: string | URL | Request,
  init?: RequestInit,
  step?: string,
  transport = "Next.js server → Box",
  credential?: string,
  reason?: string,
  /** Statuses that are a normal part of this flow, not failures. */
  expectedStatuses: number[] = [409],
) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const started = performance.now();
  let response: Response | undefined;
  try {
    response = await fetch(input, init);
    return response;
  } finally {
    const active = context.getStore();
    const event: RequestEvent = {
      step: step ?? active?.step ?? "Box API",
      method: init?.method ?? "GET",
      target: `${url.host}${url.pathname}`,
      status: response?.status ?? "network",
      ok: response?.ok ?? false,
      expected:
        response !== undefined && expectedStatuses.includes(response.status),
      durationMs: Math.round(performance.now() - started),
      transport,
      credential,
      reason: reason ?? describe(step ?? active?.step ?? "box", response?.status),
    };
    if (active && active.requests.length < 300) {
      active.requests.push(event);
      active.emit?.(event);
    }
  }
}
