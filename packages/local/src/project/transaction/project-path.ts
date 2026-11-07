import * as Effect from 'effect/Effect';
import { resolveContainedPath, type ContainedPathProblem } from '../project-path.js';
import { ProjectTransactionError } from './project-transaction-error.js';

const PROBLEM_MESSAGES: Readonly<Record<ContainedPathProblem, string>> = {
  ancestor_not_directory: 'Transaction path ancestor is not a directory.',
  invalid: 'Transaction path is not project-safe.',
  outside: 'Transaction path leaves the project.',
  symlink: 'Transaction path resolves through a symlink.',
  wrong_destination_type: 'Transaction destination is not a regular file.',
};

/** Confines authored transaction writes to the manifest and attest resource directory. */
const resolveSafeProjectPath = Effect.fn('resolveSafeProjectPath')(function* (
  root: string,
  path: string,
) {
  const problem = (kind: ContainedPathProblem): ProjectTransactionError =>
    new ProjectTransactionError('project_invalid', PROBLEM_MESSAGES[kind], { path });

  if (path !== 'attest.project.json' && !path.startsWith('attest/'))
    return yield* Effect.fail(problem('invalid'));

  return yield* resolveContainedPath(root, path, { expect: 'file', problem });
});

export { resolveSafeProjectPath };
