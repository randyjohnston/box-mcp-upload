import { traceRequests } from "@/telemetry";
import { logout } from "@/auth/session";
import { assertSameOrigin, errorResponse } from "@/http";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const { value, requests } = await traceRequests("logout", () =>
      logout(req),
    );
    return new Response(JSON.stringify({ ...(await value.json()), requests }), {
      status: value.status,
      headers: value.headers,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
