export {
  prepareProjectCandidate,
  renderCanonicalJsonFile,
  renderCanonicalJsonLinesFile,
  type CandidateFile,
  type PreparedProjectCandidate,
} from './candidate-project.js';
export {
  ProjectTransactionError,
  type ProjectTransactionErrorCode,
} from './project-transaction-error.js';
export {
  PROJECT_LOCK_FILE,
  PROJECT_LOCK_SCHEMA,
  acquireProjectLock,
  inspectProjectLock,
  releaseProjectLock,
  unlockStaleProjectLock,
  type ProjectLockHandle,
  type ProjectLockInspection,
  type ProjectLockMetadata,
} from './project-lock.js';
export { createSemanticProjectDiff, diffJsonFields } from './semantic-project-diff.js';
export {
  applyProjectMutation,
  createFileChanges,
  markTransactionCommitted,
  publishPreparedTransaction,
  type PublishEvent,
  type PublishObserver,
} from './transactional-writer.js';
export {
  JOURNAL_FILE,
  TRANSACTIONS_DIRECTORY,
  TRANSACTION_JOURNAL_SCHEMA,
  recoverProjectTransactions,
  type RecoveryResult,
} from './transaction-journal.js';
export {
  type FieldChangeKind,
  type ProjectMutationCandidate,
  type ProjectMutationRequest,
  type ProjectMutationResult,
  type ProjectRenameHint,
  type ProjectResourceKind,
  type SemanticFieldChange,
  type SemanticOperationKind,
  type SemanticProjectDiff,
  type SemanticProjectOperation,
  type SemanticReference,
  type SemanticResourceIdentity,
} from './transaction-types.js';
