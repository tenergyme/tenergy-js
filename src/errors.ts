// The error envelope of `docs/api/errors.md`, as typed exceptions.
//
// Three classes and the difference matters when you write a `catch`:
//
//   TenergyApiError       the api answered, and the answer was an error envelope. `code`/`slug`
//                         are stable; `message` is English prose and must not be parsed.
//   TenergyTransportError the api did not answer, or answered something that is not an envelope
//                         (a proxy's HTML 502, a DNS failure, an aborted socket).
//   TenergyTimeoutError   a helper that waits — `waitForOrder` — ran out of time. The order is
//                         not cancelled by this; it is still whatever the api last said.
import type { components } from './generated/openapi.js';

export type ErrorEnvelope = components['schemas']['Error'];

/** Does this look like the platform's error envelope? */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  const error = (value as ErrorEnvelope | null)?.error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof error.code === 'number' &&
    typeof error.slug === 'string'
  );
}

export class TenergyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
  }
}

export class TenergyApiError extends TenergyError {
  /** Stable numeric code from `docs/api/errors.md`. Never reused, never renumbered. */
  readonly code: number;
  /** Stable machine-readable name for the same condition. Branch on this. */
  readonly slug: string;
  readonly httpStatus: number;
  readonly field: string | null;
  /** Whether retrying the identical request could succeed later. */
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | null;
  readonly requestId: string | null;
  /** From `Retry-After`, seconds, when the api sent one. */
  readonly retryAfterSeconds: number | null;

  constructor(input: {
    envelope: ErrorEnvelope;
    httpStatus: number;
    retryAfterSeconds?: number | null;
  }) {
    const { error } = input.envelope;
    super(`${error.slug} (${error.code}): ${error.message}`);
    this.code = error.code;
    this.slug = error.slug;
    this.httpStatus = input.httpStatus;
    this.field = error.field ?? null;
    this.retryable = error.retryable === true;
    this.details = (error.details ?? null) as Record<string, unknown> | null;
    this.requestId = input.envelope.request_id ?? null;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
  }
}

export class TenergyTransportError extends TenergyError {
  readonly httpStatus: number | null;
  /** First 512 characters of whatever came back, for a support ticket. */
  readonly bodyExcerpt: string | null;

  constructor(
    message: string,
    input: { httpStatus?: number | null; bodyExcerpt?: string | null; cause?: unknown } = {},
  ) {
    super(message, input.cause === undefined ? undefined : { cause: input.cause });
    this.httpStatus = input.httpStatus ?? null;
    this.bodyExcerpt = input.bodyExcerpt ?? null;
  }
}

export class TenergyTimeoutError extends TenergyError {
  readonly waitedMs: number;
  /** The last thing the api said, so the caller need not ask again to log it. */
  readonly last: unknown;

  constructor(message: string, input: { waitedMs: number; last?: unknown }) {
    super(message);
    this.waitedMs = input.waitedMs;
    this.last = input.last ?? null;
  }
}
