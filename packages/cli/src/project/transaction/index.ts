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
  type ProjectTransactionErrorDetails,
} from './project-transaction-error.js';
export { createSemanticProjectDiff, diffJsonFields } from './semantic-project-diff.js';
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
