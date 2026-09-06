import { requireSession } from "@/auth/session";
import {
  assertSameOrigin,
  errorResponse,
  HttpError,
  maxUploadBytes,
} from "@/http";
import { stageUpload } from "@/staging";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const session = requireSession(req);
    const name = req.headers.get("x-file-name");
    if (!name) throw new HttpError(400, "Missing file name.");
    let decoded: string;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      throw new HttpError(400, "Invalid encoded file name.");
    }
    const limit = maxUploadBytes();
    if (Number(req.headers.get("content-length")) > limit)
      throw new HttpError(413, "File exceeds the upload size limit.");
    if (!req.body) throw new HttpError(400, "Request has no file body.");
    return Response.json(
      await stageUpload(req.body, decoded, limit, session.id),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
