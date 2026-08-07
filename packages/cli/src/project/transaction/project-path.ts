import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { ProjectTransactionError } from './project-transaction-error.js';

const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;

const isContainedPath = (root: string, candidate: string): boolean => {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === '' ||
    (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
  );
};

/** Rejects absolute, normalized-ambiguous, and internal transaction destination paths. */
const assertProjectRelativePath = (path: string): void => {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    isAbsolute(path) ||
    path
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
    (path !== 'attest.project.json' && !path.startsWith('attest/'))
  ) {
    throw new ProjectTransactionError('project_invalid', 'Transaction path is not project-safe.', {
      path,
    });
  }
};

/** Resolves a generated authored path after rejecting symlinked ancestors and destinations. */
const resolveSafeProjectPath = async (root: string, path: string): Promise<string> => {
  assertProjectRelativePath(path);
  const resolvedRoot = await realpath(root);
  const destination = resolve(resolvedRoot, path);
  if (!isContainedPath(resolvedRoot, destination)) {
    throw new ProjectTransactionError('project_invalid', 'Transaction path leaves the project.', {
      path,
    });
  }

  const segments = path.split('/');
  let current = resolvedRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new ProjectTransactionError(
          'project_invalid',
          'Transaction path resolves through a symlink.',
          { path },
        );
      }
      if (index < segments.length - 1 && !metadata.isDirectory()) {
        throw new ProjectTransactionError(
          'project_invalid',
          'Transaction path ancestor is not a directory.',
          { path },
        );
      }
      if (index === segments.length - 1 && !metadata.isFile()) {
        throw new ProjectTransactionError(
          'project_invalid',
          'Transaction destination is not a regular file.',
          { path },
        );
      }
    } catch (error: unknown) {
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }
      // Once an ancestor is missing, every remaining path is lexical until created locally.
      break;
    }
  }
  return destination;
};

export { assertProjectRelativePath, resolveSafeProjectPath };
