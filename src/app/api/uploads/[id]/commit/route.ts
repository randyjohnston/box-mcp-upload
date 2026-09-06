import { z } from "zod";
import { connectedApps, credentialFor, requireSession } from "@/auth/session";
import { assertSameOrigin, errorResponse, HttpError } from "@/http";
import { publicError } from "@/errors";
import { assertSafeName } from "@/box/folders";
import { readStaged } from "@/staging";
import { callBoxTool } from "@/mcp/client";
export const runtime = "nodejs";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(req);
    const session = requireSession(req);
    const { id } = await params;
    const input = z
      .object({
        folder: z.string().max(255).optional(),
        app: z.enum(["mcp", "platform", "ccg"]).optional(),
      })
      .strict()
      .safeParse(await req.json().catch(() => null));
    if (!input.success)
      throw new HttpError(400, "Expected JSON with an optional folder name.");
    const folder = input.data.folder
      ? assertSafeName(input.data.folder, "folder")
      : undefined;
    const app = input.data.app;
    if (app && !connectedApps(session).includes(app))
      throw new HttpError(400, "That Box application is not connected.");
    await readStaged(id, session.id);
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          if (!closed)
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
        };
        try {
          const result = await callBoxTool(
            { id: session.id, auth: credentialFor(session, app).auth },
            "box_upload_file",
            { uploadId: id, folder },
            {
              onrequest: (event) => send("request", event),
              onprogress: (p) => send("progress", p),
            },
          );
          send("done", result);
        } catch (error) {
          send("error", { message: publicError(error) });
        } finally {
          if (!closed) {
            closed = true;
            controller.close();
          }
        }
      },
      // Finish an already-started Box commit even if the browser disconnects.
      cancel() {
        closed = true;
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
