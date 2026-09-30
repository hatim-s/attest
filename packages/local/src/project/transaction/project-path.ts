import { resolveContainedPath, type ContainedPathProblem } from '../project-path.js';
import { ProjectTransactionError } from './project-transaction-error.js';

const PROBLEM_MESSAGES: Readonly<Record<ContainedPathProblem, string>> = {
  ancestor_not_directory: 'Transaction path ancestor is not a directory.',
  invalid: 'Transaction path is not project-safe.',
  outside: 'Transaction path leaves the project.',
  symlink: 'Transaction path resolves through a symlink.',
  wrong_destination_type: 'Transaction destination is not a regular file.',
};

/**
 * Resolves a generated authored path for a transaction write. Transactions only touch the
 * manifest and files under `attest/`, never `.attest` state or anything reached by a symlink.
 */
const resolveSafeProjectPath = async (root: string, path: string): Promise<string> => {
  const problem = (kind: ContainedPathProblem): ProjectTransactionError =>
    new ProjectTransactionError('project_invalid', PROBLEM_MESSAGES[kind], { path });
  if (path !== 'attest.project.json' && !path.startsWith('attest/')) throw problem('invalid');
  return resolveContainedPath(root, path, { expect: 'file', problem });
};

export { resolveSafeProjectPath };
