import { AttestError, type JsonValue } from '@attest/contracts';

type LocalErrorCode =
  | 'cancelled'
  | 'cli_missing_input'
  | 'cli_usage'
  | 'init_conflict'
  | 'init_failed'
  | 'internal_error'
  | 'invocation_failed'
  | 'metric_fixture_mismatch'
  | 'metric_infrastructure_failed'
  | 'output_exists'
  | 'output_write_failed'
  | 'project_changed'
  | 'project_invalid'
  | 'project_lock_stale'
  | 'project_locked'
  | 'project_not_found'
  | 'project_read_failed'
  | 'project_recovery_required'
  | 'project_transaction_failed'
  | 'resource_not_found'
  | 'run_failed'
  | 'trace_convert_failed';

type LocalErrorOptions = ErrorOptions & {
  details?: JsonValue;
  hint?: string;
  path?: string;
};

/** Carries safe local-operation failure details without assigning CLI exit behavior. */
class LocalError extends AttestError {
  readonly code: LocalErrorCode;
  readonly details: JsonValue | undefined;
  readonly hint: string | undefined;
  readonly path: string | undefined;

  constructor(code: LocalErrorCode, message: string, options?: LocalErrorOptions) {
    super(code, message, options);
    this.code = code;
    this.details = options?.details;
    this.hint = options?.hint;
    this.path = options?.path;
  }
}

export { LocalError, type LocalErrorCode, type LocalErrorOptions };
