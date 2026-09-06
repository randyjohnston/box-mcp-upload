import { credentialFor, requireSession } from "@/auth/session";
import { errorResponse } from "@/http";
import { callBoxTool } from "@/mcp/client";
export const runtime = "nodejs";
export async function GET(req: Request) {
  try {
    const session = requireSession(req);
    const folder = new URL(req.url).searchParams.get("folder") ?? undefined;
    return Response.json(
      await callBoxTool(
        { id: session.id, auth: credentialFor(session).auth },
        "box_list_folder",
        { folder },
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
