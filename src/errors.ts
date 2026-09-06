import type { RequestEvent } from "./request-event";
export class HttpError extends Error {
  requests?: RequestEvent[];
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function publicError(error: unknown): string {
  return error instanceof HttpError
    ? error.message
    : "The request could not be completed. Please try again.";
}
