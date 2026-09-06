import { traceRequests } from "@/telemetry";
import { login } from "@/auth/session";
import { assertSameOrigin, errorResponse } from "@/http";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    return (await traceRequests("login", () => login(req))).value;
  } catch (error) {
    return errorResponse(error);
  }
}
