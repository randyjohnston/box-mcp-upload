import { traceRequests } from "@/telemetry";
import { callback } from "@/auth/session";
import { errorResponse } from "@/http";
export const runtime = "nodejs";
export async function GET(req: Request) {
  try {
    return (await traceRequests("callback", () => callback(req))).value;
  } catch (error) {
    return errorResponse(error);
  }
}
