import { NextResponse } from "next/server";
import { appOrigin } from "./box/config";
import { HttpError, publicError } from "./errors";
export { HttpError } from "./errors";

export function maxUploadBytes(): number {
  const value = process.env.MAX_UPLOAD_BYTES;
  const limit = value ? Number(value) : 512 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new Error("MAX_UPLOAD_BYTES must be a positive integer.");
  return limit;
}
export function assertSameOrigin(req: Request): void {
  if (
    req.headers.get("origin") !== appOrigin() ||
    req.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new HttpError(403, "A same-origin request is required.");
  }
}
export function errorResponse(error: unknown): NextResponse {
  return NextResponse.json(
    {
      error: publicError(error),
      requests: error instanceof HttpError ? error.requests : undefined,
    },
    {
      status: error instanceof HttpError ? error.status : 500,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
