import { AttestError } from '@attest/contracts';

import type { RunStartDiagnostics } from '../records/run-control-schemas.js';

type StoreErrorCode =
  | 'SCHEMA_TOO_NEW'
  | 'SCHEMA_OUTDATED'
  | 'RUN_NOT_FOUND'
  | 'CASE_NOT_FOUND'
  | 'PROJECT_NOT_FOUND'
  | 'INVALID_CURSOR'
  | 'INVALID_LIMIT'
  | 'RUN_FINALIZED'
  | 'CASE_CONFLICT'
  | 'INVALID_JSON'
  | 'CORRUPT_DATA'
  | 'WRITE_FAILED'
  | 'READ_FAILED'
  | 'DRIVER_MISUSE'
  | 'INVALID_RECORD'
  | 'RUN_START_FAILED'
  | 'CONTROL_UNAVAILABLE';

type StoreErrorOptions = ErrorOptions & {
  /** What the CLI reported when a run did not start; set with RUN_START_FAILED. */
  details?: RunStartDiagnostics;
};

/** Identifies exceptional store failures that callers can render without parsing messages. */
class StoreError extends AttestError {
  declare readonly code: StoreErrorCode;
  readonly details: RunStartDiagnostics | undefined;

  constructor(code: StoreErrorCode, message: string, options?: StoreErrorOptions) {
    super(code, message, options);
    this.details = options?.details;
  }
}

export { StoreError, type StoreErrorCode };
