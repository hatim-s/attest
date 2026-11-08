import type { CliDiagnostics } from '@attest/core/records';
import * as Data from 'effect/Data';

import type { ApiErrorCode } from '../contract/errors.js';

type ApiErrorOptions = {
  /** What the CLI or the project loader reported (RUN_START_FAILED, PROJECT_UNLOADABLE). */
  details?: CliDiagnostics;
};

/** Preserves a response status even when a proxy returns a body outside the contract. */
class ApiError extends Error {
  readonly details: CliDiagnostics | undefined;

  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'INVALID_RESPONSE',
    message: string,
    options?: ApiErrorOptions,
  ) {
    super(message);
    this.name = 'ApiError';
    this.details = options?.details;
  }
}

/**
 * A fetch or body read that failed before the API answered. Keeps the foreign failure's
 * message so callers that render `error.message` show the same text as before.
 */
class ApiRequestError extends Data.TaggedError('ApiRequestError')<{
  message: string;
  cause: unknown;
}> {}

export { ApiError, ApiRequestError };
