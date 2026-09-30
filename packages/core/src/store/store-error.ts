import { AttestError } from '@attest/contracts';

type StoreErrorCode =
  | 'SCHEMA_TOO_NEW'
  | 'SCHEMA_OUTDATED'
  | 'RUN_NOT_FOUND'
  | 'CASE_NOT_FOUND'
  | 'INVALID_CURSOR'
  | 'INVALID_LIMIT'
  | 'RUN_FINALIZED'
  | 'CASE_CONFLICT'
  | 'INVALID_JSON'
  | 'CORRUPT_DATA'
  | 'WRITE_FAILED'
  | 'READ_FAILED'
  | 'DRIVER_MISUSE'
  | 'INVALID_RECORD';

/** Identifies exceptional store failures that callers can render without parsing messages. */
class StoreError extends AttestError {
  declare readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options);
  }
}

export { StoreError, type StoreErrorCode };
