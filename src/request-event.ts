export type RequestEvent = {
  credential?: string;
  step: string;
  method: string;
  target: string;
  status: number | string;
  ok: boolean;
  durationMs?: number;
  transport?: string;
  detail?: string;
  /**
   * Why this particular request happened, decided where the routing choice is
   * actually made rather than labelled in bulk by the caller.
   */
  reason?: string;
  /** True when a non-2xx status is a normal part of the flow (e.g. 409). */
  expected?: boolean;
};
