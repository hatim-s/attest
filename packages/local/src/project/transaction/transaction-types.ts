import type { ProjectResources } from '@attest/contracts';

type ProjectResourceKind = 'agent' | 'dataset' | 'metric' | 'project' | 'test';
type SemanticOperationKind = 'add' | 'attach' | 'detach' | 'remove' | 'rename' | 'update';
type FieldChangeKind = 'add' | 'remove' | 'update';

type SemanticFieldChange = {
  change: FieldChangeKind;
  path: string;
};

type SemanticReference = {
  id: string;
  path: string;
  type: 'agent' | 'dataset' | 'metric';
};

type SemanticResourceIdentity = {
  id: string;
  type: ProjectResourceKind;
};

type SemanticProjectOperation = {
  changes: readonly SemanticFieldChange[];
  new_content_hash?: string;
  old_content_hash?: string;
  op: SemanticOperationKind;
  previous_id?: string;
  references_added: readonly SemanticReference[];
  references_removed: readonly SemanticReference[];
  resource: SemanticResourceIdentity;
};

type SemanticProjectDiff = {
  operations: readonly SemanticProjectOperation[];
  warnings: readonly string[];
};

type ProjectRenameHint = {
  from: string;
  to: string;
  type: Exclude<ProjectResourceKind, 'project'>;
};

type ProjectMutationCandidate = ProjectResources;

type ProjectMutationRequest = {
  candidate: ProjectMutationCandidate;
  dryRun?: boolean;
  expectedProjectHash?: string;
  projectRoot: string;
  renames?: readonly ProjectRenameHint[];
  warnings?: readonly string[];
};

type ProjectMutationResult = {
  committed: boolean;
  diff: SemanticProjectDiff;
  projectHashAfter: string;
  projectHashBefore: string;
  transactionId?: string;
};

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
};
