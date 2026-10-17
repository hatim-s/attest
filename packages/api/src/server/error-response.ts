import { StoreError, type StoreErrorCode } from '@attest/core';
import { z } from 'zod';

import type { ApiErrorCode, ApiErrorEnvelope } from '../contract/errors.js';

class InvalidRequestError extends Error {}

/** BOUNDARY: Parses untrusted request parameters once before the source receives them. */
const parseInput = <Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> => {
  const parsed = schema.safeParse(input);

  if (!parsed.success) throw new InvalidRequestError(z.prettifyError(parsed.error));

  return parsed.data;
};

const INTERNAL_MESSAGE = 'The API could not complete the request.';

const API_CODE_BY_STORE_CODE = {
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  CASE_NOT_FOUND: 'CASE_NOT_FOUND',
  INVALID_CURSOR: 'INVALID_CURSOR',
  INVALID_LIMIT: 'INVALID_REQUEST',
  SCHEMA_TOO_NEW: 'SOURCE_UNREADABLE',
  SCHEMA_OUTDATED: 'SOURCE_UNREADABLE',
  CORRUPT_DATA: 'SOURCE_UNREADABLE',
  READ_FAILED: 'SOURCE_UNREADABLE',
  INVALID_JSON: 'INTERNAL_ERROR',
  INVALID_RECORD: 'INTERNAL_ERROR',
  RUN_FINALIZED: 'INTERNAL_ERROR',
  CASE_CONFLICT: 'INTERNAL_ERROR',
  WRITE_FAILED: 'INTERNAL_ERROR',
  DRIVER_MISUSE: 'INTERNAL_ERROR',
} as const satisfies Record<StoreErrorCode, ApiErrorCode>;

/** Keeps source diagnostics actionable while withholding unexpected failure details. */
const toErrorEnvelope = (error: Error): ApiErrorEnvelope => {
  if (error instanceof InvalidRequestError) {
    return { error: { code: 'INVALID_REQUEST', message: error.message } };
  }

  if (!(error instanceof StoreError)) {
    return { error: { code: 'INTERNAL_ERROR', message: INTERNAL_MESSAGE } };
  }

  const code = API_CODE_BY_STORE_CODE[error.code];

  return { error: { code, message: code === 'INTERNAL_ERROR' ? INTERNAL_MESSAGE : error.message } };
};

export { parseInput, toErrorEnvelope };
