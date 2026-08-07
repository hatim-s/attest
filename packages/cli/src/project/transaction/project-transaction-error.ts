type ProjectTransactionErrorCode =
  | 'candidate_invalid'
  | 'project_changed'
  | 'project_lock_invalid'
  | 'project_lock_live'
  | 'project_lock_stale'
  | 'transaction_failed'
  | 'transaction_recovery_conflict'
  | 'transaction_recovery_required'
  | 'unsafe_transaction_path';

type ProjectTransactionErrorDetails = Readonly<Record<string, unknown>>;

/** Identifies an expected transactional authoring failure with machine-readable details. */
class ProjectTransactionError extends Error {
  readonly code: ProjectTransactionErrorCode;
  readonly details: ProjectTransactionErrorDetails;

  constructor(
    code: ProjectTransactionErrorCode,
    message: string,
    details: ProjectTransactionErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProjectTransactionError';
    this.code = code;
    this.details = details;
  }
}

export {
  ProjectTransactionError,
  type ProjectTransactionErrorCode,
  type ProjectTransactionErrorDetails,
};
