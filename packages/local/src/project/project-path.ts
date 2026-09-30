import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { errnoCode } from '../internal/errno-code.js';

type ContainedPathProblem =
  'ancestor_not_directory' | 'invalid' | 'outside' | 'symlink' | 'wrong_destination_type';

type ResolveContainedPathOptions = {
  /** Accepts an absolute path that lands inside the root instead of rejecting it. */
  allowAbsolute?: boolean;
  /** Creates missing directories (mode 0700) while walking, including a directory destination. */
  createDirectories?: boolean;
  /** The kind the final segment must have when it already exists. */
  expect: 'directory' | 'file';
  /** Builds the caller's typed error; filesystem errors other than ENOENT propagate as-is. */
  problem: (problem: ContainedPathProblem) => Error;
};

/** Returns whether a resolved candidate path is the project root or one of its descendants. */
const isProjectPath = (root: string, candidate: string): boolean => {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === '' ||
    (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
  );
};

/** Maps an absolute path through its nearest existing ancestor without resolving the final entry. */
const relativeFromAbsolute = async (
  resolvedRoot: string,
  path: string,
  options: ResolveContainedPathOptions,
): Promise<string> => {
  if (path.split(sep).some((segment) => segment === '.' || segment === '..')) {
    throw options.problem('invalid');
  }
  const suffix = [basename(path)];
  let ancestor = dirname(path);
  let resolvedAncestor: string | undefined;
  while (resolvedAncestor === undefined) {
    try {
      resolvedAncestor = await realpath(ancestor);
    } catch (error: unknown) {
      if (errnoCode(error) !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw options.problem('outside');
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  const candidate = resolve(resolvedAncestor, ...suffix);
  if (!isProjectPath(resolvedRoot, candidate)) throw options.problem('outside');
  return relative(resolvedRoot, candidate);
};

/**
 * Resolves a path inside `root` one segment at a time, rejecting symlinks and wrong entry
 * kinds on the way. Checking each segment with lstat means a symlink planted anywhere in the
 * path cannot redirect a later read or write outside the project.
 */
const resolveContainedPath = async (
  root: string,
  path: string,
  options: ResolveContainedPathOptions,
): Promise<string> => {
  const resolvedRoot = await realpath(root);
  const projectPath =
    isAbsolute(path) && options.allowAbsolute === true
      ? await relativeFromAbsolute(resolvedRoot, path, options)
      : path;
  if (
    projectPath.length === 0 ||
    projectPath.includes('\0') ||
    projectPath.includes('\\') ||
    isAbsolute(projectPath) ||
    projectPath
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw options.problem('invalid');
  }
  const candidate = resolve(resolvedRoot, projectPath);
  if (!isProjectPath(resolvedRoot, candidate)) throw options.problem('outside');

  const segments = relative(resolvedRoot, candidate).split(sep);
  let current = resolvedRoot;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const destination = index === segments.length - 1;
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current);
    } catch (error: unknown) {
      if (errnoCode(error) !== 'ENOENT') throw error;
      const createHere =
        options.createDirectories === true && (!destination || options.expect === 'directory');
      // Once an entry is missing and not created here, the rest of the path is only lexical.
      if (!createHere) break;
      await mkdir(current, { mode: 0o700 });
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink()) throw options.problem('symlink');
    if (!destination && !metadata.isDirectory()) throw options.problem('ancestor_not_directory');
    const wrongType = options.expect === 'file' ? !metadata.isFile() : !metadata.isDirectory();
    if (destination && wrongType) throw options.problem('wrong_destination_type');
  }
  return candidate;
};

export {
  isProjectPath,
  resolveContainedPath,
  type ContainedPathProblem,
  type ResolveContainedPathOptions,
};
