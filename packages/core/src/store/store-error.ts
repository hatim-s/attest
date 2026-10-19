import { AttestError } from '@attest/contracts';

import type { CliDiagnostics } from '../records/run-control-schemas.js';

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
  | 'PROJECT_UNLOADABLE'
  | 'CONTROL_UNAVAILABLE';

/** The codes that say what the CLI or the project loader reported, and only those. */
type DiagnosticsCode = Extract<StoreErrorCode, 'RUN_START_FAILED' | 'PROJECT_UNLOADABLE'>;

/** Identifies exceptional store failures that callers can render without parsing messages. */
class StoreError extends AttestError {
  declare readonly code: StoreErrorCode;
  readonly details: CliDiagnostics | undefined;

  constructor(
    code: DiagnosticsCode,
    message: string,
    options: ErrorOptions & { details: CliDiagnostics },
  );
  constructor(
    code: Exclude<StoreErrorCode, DiagnosticsCode>,
    message: string,
    options?: ErrorOptions,
  );
  constructor(
    code: StoreErrorCode,
    message: string,
    options?: ErrorOptions & { details?: CliDiagnostics },
  ) {
    super(code, message, options);
    this.details = options?.details;
  }
}

export { StoreError, type StoreErrorCode };
