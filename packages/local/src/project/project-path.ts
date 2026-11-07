import * as Effect from 'effect/Effect';
import { anchoredCall } from '../internal/open-anchored.js';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

type ContainedPathProblem =
  'ancestor_not_directory' | 'invalid' | 'outside' | 'symlink' | 'wrong_destination_type';

type ResolveContainedPathOptions<E extends Error> = {
  /** Accepts an absolute path that lands inside the root instead of rejecting it. */
  allowAbsolute?: boolean;
  /** Creates missing directories (mode 0700) while walking, including a directory destination. */
  createDirectories?: boolean;
  /** The kind the final segment must have when it already exists. */
  expect: 'directory' | 'file';
  /** Builds the caller's typed rejection; syscall failures retain errno and cause. */
  problem: (problem: ContainedPathProblem) => E;
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
const relativeFromAbsolute = Effect.fn('relativeFromAbsolute')(function* <E extends Error>(
  resolvedRoot: string,
  path: string,
  options: ResolveContainedPathOptions<E>,
) {
  if (path.split(sep).some((segment) => segment === '.' || segment === '..')) {
    return yield* Effect.fail(options.problem('invalid'));
  }

  const suffix = [basename(path)];
  let ancestor = dirname(path);
  let resolvedAncestor: string | undefined;

  while (resolvedAncestor === undefined) {
    const result = yield* Effect.result(
      anchoredCall('realpath', ancestor, () => realpath(ancestor)),
    );

    if (result._tag === 'Success') resolvedAncestor = result.success;
    else {
      if (result.failure.code !== 'ENOENT') return yield* Effect.fail(result.failure);
      const parent = dirname(ancestor);

      if (parent === ancestor) return yield* Effect.fail(options.problem('outside'));
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }

  const candidate = resolve(resolvedAncestor, ...suffix);

  if (!isProjectPath(resolvedRoot, candidate))
    return yield* Effect.fail(options.problem('outside'));

  return relative(resolvedRoot, candidate);
});

/**
 * Resolves a path inside `root` one segment at a time, rejecting symlinks and wrong entry
 * kinds on the way. Checking each segment with lstat means a symlink planted anywhere in the
 * path cannot redirect a later read or write outside the project.
 */
const resolveContainedPath = Effect.fn('resolveContainedPath')(function* <E extends Error>(
  root: string,
  path: string,
  options: ResolveContainedPathOptions<E>,
) {
  const resolvedRoot = yield* anchoredCall('realpath', root, () => realpath(root));

  const projectPath =
    isAbsolute(path) && options.allowAbsolute === true
      ? yield* relativeFromAbsolute(resolvedRoot, path, options)
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
    return yield* Effect.fail(options.problem('invalid'));
  }

  const candidate = resolve(resolvedRoot, projectPath);

  if (!isProjectPath(resolvedRoot, candidate))
    return yield* Effect.fail(options.problem('outside'));

  const segments = relative(resolvedRoot, candidate).split(sep);
  let current = resolvedRoot;

  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const destination = index === segments.length - 1;
    let metadata: Awaited<ReturnType<typeof lstat>>;

    const inspected = yield* Effect.result(anchoredCall('lstat', current, () => lstat(current)));

    if (inspected._tag === 'Success') metadata = inspected.success;
    else {
      if (inspected.failure.code !== 'ENOENT') return yield* Effect.fail(inspected.failure);

      const createHere =
        options.createDirectories === true && (!destination || options.expect === 'directory');

      // Missing uncreated suffixes remain lexical until the eventual anchored open.
      if (!createHere) break;
      yield* anchoredCall('mkdir', current, () => mkdir(current, { mode: 0o700 })).pipe(
        Effect.catch((error) => (error.code === 'EEXIST' ? Effect.void : Effect.fail(error))),
      );
      metadata = yield* anchoredCall('lstat', current, () => lstat(current));
    }

    if (metadata.isSymbolicLink()) return yield* Effect.fail(options.problem('symlink'));

    if (!destination && !metadata.isDirectory())
      return yield* Effect.fail(options.problem('ancestor_not_directory'));
    const wrongType = options.expect === 'file' ? !metadata.isFile() : !metadata.isDirectory();

    if (destination && wrongType)
      return yield* Effect.fail(options.problem('wrong_destination_type'));
  }

  return candidate;
});

export { isProjectPath, resolveContainedPath, type ContainedPathProblem };
