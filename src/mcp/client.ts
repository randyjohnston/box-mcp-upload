import { traceRequests } from "../telemetry";
import type { RequestEvent } from "../request-event";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BoxClient } from "../box/client";
import type { TokenProvider } from "../box/auth";
import { HttpError } from "../errors";
import { createBoxServer } from "./tools";

// Each connection closes over one authenticated session; tokens never enter tool arguments.
export async function callBoxTool<T>(
  session: { id: string; auth: TokenProvider },
  name: string,
  args: Record<string, unknown>,
  options?: {
    onrequest?: (event: RequestEvent) => void;
    onprogress?: (p: {
      progress: number;
      total?: number;
      message?: string;
    }) => void;
  },
) {
  const traced = await traceRequests(
    name,
    async () => {
      const [local, remote] = InMemoryTransport.createLinkedPair();
      const server = createBoxServer(
        new BoxClient(session.auth),
        session.id,
        session.auth,
        session.auth.app ?? "ccg",
      );
      const client = new Client({ name: "box-upload-web", version: "0.2.0" });
      try {
        await server.connect(remote);
        await client.connect(local);
        const result = await client.callTool(
          { name, arguments: args },
          undefined,
          {
            ...options,
            timeout: 15 * 60_000,
            maxTotalTimeout: 15 * 60_000,
          },
        );
        if (result.isError) {
          const error = result.structuredContent as
            { status?: number; error?: string } | undefined;
          throw new HttpError(
            error?.status ?? 502,
            error?.error ?? "Box request failed.",
          );
        }
        return result.structuredContent as T;
      } finally {
        await Promise.allSettled([client.close(), server.close()]);
      }
    },
    options?.onrequest,
  );
  return {
    ...(traced.value as Record<string, unknown>),
    requests: traced.requests,
  } as T & { requests: RequestEvent[] };
}
