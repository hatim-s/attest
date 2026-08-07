import { AttestCliError, type AttestCliErrorOptions, type CliErrorCode } from '../../errors.js';

type ProjectTransactionErrorCode = Extract<
  CliErrorCode,
  | 'project_changed'
  | 'project_invalid'
  | 'project_locked'
  | 'project_lock_stale'
  | 'project_recovery_required'
  | 'project_transaction_failed'
>;

/** Identifies an expected transactional authoring failure with stable CLI output semantics. */
class ProjectTransactionError extends AttestCliError {
  constructor(code: ProjectTransactionErrorCode, message: string, options?: AttestCliErrorOptions) {
    super(code, message, options);
    this.name = 'ProjectTransactionError';
  }
}

export { ProjectTransactionError, type ProjectTransactionErrorCode };
