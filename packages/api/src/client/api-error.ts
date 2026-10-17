import type { ApiErrorCode } from '../contract/errors.js';

/** Preserves a response status even when a proxy returns a body outside the contract. */
class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'INVALID_RESPONSE',
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export { ApiError };
