import { z } from "zod";
import { connectedApps, credentialFor, requireSession } from "@/auth/session";
import {
  assertSameOrigin,
  errorResponse,
  HttpError,
  maxUploadBytes,
} from "@/http";
import { callBoxTool } from "@/mcp/client";
export const runtime = "nodejs";
const authApp = z.enum(["mcp", "platform", "ccg"]).optional();
const action = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("prepare"),
      name: z.string().max(255),
      size: z.number().int().positive(),
      folder: z.string().max(255).optional(),
      app: authApp,
    })
    .strict(),
  z
    .object({
      action: z.literal("finish"),
      id: z.string().uuid(),
      digest: z
        .string()
        .regex(/^[A-Za-z0-9+/]{27}=$/)
        .optional(),
      app: authApp,
    })
    .strict(),
]);
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const session = requireSession(req);
    const parsed = action.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      throw new HttpError(400, "Invalid direct upload request.");
    const { action: kind, app, ...args } = parsed.data;
    // Only a credential this session actually holds may be used; the browser
    // names the app, it never supplies one.
    if (app && !connectedApps(session).includes(app))
      throw new HttpError(400, "That Box application is not connected.");
    if ("size" in args && args.size > maxUploadBytes())
      throw new HttpError(413, "File exceeds the upload size limit.");
    return Response.json(
      await callBoxTool(
        { id: session.id, auth: credentialFor(session, app).auth },
        kind === "prepare" ? "box_prepare_upload" : "box_finish_upload",
        args,
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
