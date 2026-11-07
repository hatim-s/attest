import { parseWithSchema } from '@attest/contracts';
import { StoreError, type StoreErrorCode } from '@attest/core';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Schema from 'effect/Schema';

import type { ApiErrorCode, ApiErrorEnvelope } from '../contract/errors.js';

class InvalidRequestError extends Error {}

/** BOUNDARY: Parses untrusted request parameters once before the source receives them. */
const parseInput = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): S['Type'] => {
  const parsed = parseWithSchema(schema, input);

  if (!parsed.ok)
    throw new InvalidRequestError(
      parsed.error.issues
        .map(({ path, message }) => `${path.map(String).join('.')}: ${message}`)
        .join('; '),
    );

  return parsed.value;
};

/** Reads a request body once; malformed JSON fails the same way as a body the schema rejects. */
const parseJsonBody = async <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  request: Request,
): Promise<S['Type']> => {
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

/**
 * Preserves typed source failures at the HTTP root. Defects and interruption keep
 * their full internal Cause and receive the safe internal-error projection.
 */
const readExitValue = <A>(exit: Exit.Exit<A, StoreError>): A => {
  if (Exit.isSuccess(exit)) return exit.value;

  if (!Cause.hasDies(exit.cause) && !Cause.hasInterrupts(exit.cause)) {
    for (const reason of exit.cause.reasons) {
      if (Cause.isFailReason(reason)) {
        Object.defineProperty(reason.error, 'effectCause', {
          value: exit.cause,
          configurable: true,
        });
        throw reason.error;
      }
    }
  }

  throw new Error(INTERNAL_MESSAGE, { cause: exit.cause });
};

export { parseInput, parseJsonBody, toErrorEnvelope, readExitValue };
