import { LocalError, type LocalErrorOptions, type LocalErrorCode } from '../../errors/index.js';

type ProjectTransactionErrorCode = Extract<
  LocalErrorCode,
  | 'project_changed'
  | 'project_invalid'
  | 'project_locked'
  | 'project_lock_stale'
  | 'project_recovery_required'
  | 'project_transaction_failed'
>;

/** Identifies an expected transactional authoring failure with stable CLI output semantics. */
class ProjectTransactionError extends LocalError {
  constructor(code: ProjectTransactionErrorCode, message: string, options?: LocalErrorOptions) {
    super(code, message, options);
    this.name = 'ProjectTransactionError';
  }
}

export { ProjectTransactionError, type ProjectTransactionErrorCode };
