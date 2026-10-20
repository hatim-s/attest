import { AttestError, type JsonValue } from '@attest/contracts';

type LocalErrorCode =
  | 'cancelled'
  | 'cli_missing_input'
  | 'cli_usage'
  | 'cloud_auth_required'
  | 'cloud_credentials_failed'
  | 'cloud_credentials_invalid'
  | 'cloud_request_failed'
  | 'cloud_unavailable'
  | 'execution_unavailable'
  | 'init_conflict'
  | 'init_failed'
  | 'internal_error'
  | 'invalid_bundle'
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
  | 'project_saved_cleanup_failed'
  | 'project_transaction_failed'
  | 'registry_invalid'
  | 'registry_write_failed'
  | 'resource_not_found'
  | 'run_conflict'
  | 'run_failed'
  | 'run_not_finished'
  | 'token_scope'
  | 'trace_convert_failed'
  | 'upload_too_large';

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
