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

/** Reads a request body once; malformed JSON fails the same way as a body the schema rejects. */
const parseJsonBody = async <Schema extends z.ZodType>(
  schema: Schema,
  request: Request,
): Promise<z.output<Schema>> => {
  const text = await request.text();
  let body: unknown;

  try {
    body = JSON.parse(text);
  } catch {
    throw new InvalidRequestError('The request body is not valid JSON.');
  }

  return parseInput(schema, body);
};

const INTERNAL_MESSAGE = 'The API could not complete the request.';

const API_CODE_BY_STORE_CODE = {
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  CASE_NOT_FOUND: 'CASE_NOT_FOUND',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
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
  RUN_START_FAILED: 'RUN_START_FAILED',
  PROJECT_UNLOADABLE: 'PROJECT_UNLOADABLE',
  CONTROL_UNAVAILABLE: 'CONTROL_UNAVAILABLE',
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

  if (code === 'INTERNAL_ERROR') return { error: { code, message: INTERNAL_MESSAGE } };

  return { error: { code, message: error.message, details: error.details } };
};

export { parseInput, parseJsonBody, toErrorEnvelope };
