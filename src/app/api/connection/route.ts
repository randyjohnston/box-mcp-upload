import { traceRequests } from "@/telemetry";
import { credentialFor, primaryApp, requireSession } from "@/auth/session";
import { errorResponse } from "@/http";
import { inspectHostedMcp } from "@/mcp/hosted";
export const runtime = "nodejs";
export async function GET(req: Request) {
  try {
    const session = requireSession(req);
    const { value: result, requests } = await traceRequests(
      "Inspect hosted MCP",
      () => inspectHostedMcp(credentialFor(session).auth),
    );
    return Response.json(
      { provider: primaryApp(session), requests, ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
