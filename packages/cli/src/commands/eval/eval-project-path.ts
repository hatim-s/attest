import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readlink, realpath, rename, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { openStore, type AttestStore } from '@attest/core';

import { AttestCliError, type CliErrorCode } from '../../errors/index.js';
import { isProjectPath } from '../../project/project-path.js';

const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;

type PrepareEvalProjectFileOptions = {
  allowAbsolute?: boolean;
  createDirectories?: boolean;
  errorCode: CliErrorCode;
  message: string;
};

type EvalStoreBoundaryHooks = {
  beforeCapture?: () => Promise<void> | void;
};

/** Maps an absolute output through its nearest existing ancestor without resolving the final file. */
const normalizeAbsoluteProjectFile = async (
  resolvedRoot: string,
  configuredPath: string,
  unsafe: () => AttestCliError,
): Promise<string> => {
  const authoredSegments = configuredPath.split(sep).slice(1);
  if (authoredSegments.some((segment) => segment === '.' || segment === '..')) throw unsafe();
  const suffix = [basename(configuredPath)];
  let ancestor = dirname(configuredPath);
  let resolvedAncestor: string | undefined;
  while (resolvedAncestor === undefined) {
    try {
      resolvedAncestor = await realpath(ancestor);
    } catch (error: unknown) {
      if (getErrorCode(error) !== 'ENOENT') throw unsafe();
      const parent = dirname(ancestor);
      if (parent === ancestor) throw unsafe();
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  const candidate = resolve(resolvedAncestor, ...suffix);
  if (!isProjectPath(resolvedRoot, candidate)) throw unsafe();
  return relative(resolvedRoot, candidate);
};

/** Resolves one project-controlled file after rejecting traversal and symlinked path segments. */
const prepareEvalProjectFile = async (
  projectRoot: string,
  configuredPath: string,
  options: PrepareEvalProjectFileOptions,
): Promise<string> => {
  const resolvedRoot = await realpath(projectRoot);
  const unsafe = (): AttestCliError =>
    new AttestCliError(options.errorCode, options.message, { path: configuredPath });
  const projectPath = isAbsolute(configuredPath)
    ? options.allowAbsolute === true
      ? await normalizeAbsoluteProjectFile(resolvedRoot, configuredPath, unsafe)
      : configuredPath
    : configuredPath;
  const candidate = resolve(resolvedRoot, projectPath);
  const fromRoot = relative(resolvedRoot, candidate);
  const segments = fromRoot.split(sep);
  const authoredSegments = projectPath.split('/');
  if (
    projectPath.length === 0 ||
    projectPath.includes('\0') ||
    projectPath.includes('\\') ||
    isAbsolute(projectPath) ||
    !isProjectPath(resolvedRoot, candidate) ||
    authoredSegments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    ) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw unsafe();
  }

  let current = resolvedRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    const destination = index === segments.length - 1;
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current);
    } catch (error: unknown) {
      if (getErrorCode(error) !== 'ENOENT') throw unsafe();
      if (destination || options.createDirectories !== true) break;
      try {
        await mkdir(current, { mode: 0o700 });
        metadata = await lstat(current);
      } catch {
        throw unsafe();
      }
    }
    if (
      metadata.isSymbolicLink() ||
      (!destination && !metadata.isDirectory()) ||
      (destination && !metadata.isFile())
    ) {
      throw unsafe();
    }
  }
  return candidate;
};

const sameDirectoryIdentity = (
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean =>
  left.isDirectory() &&
  right.isDirectory() &&
  !right.isSymbolicLink() &&
  left.dev === right.dev &&
  left.ino === right.ino;

/** Removes only the temporary symlink owned by this store capture. */
const removeStorePlaceholder = async (path: string, target: string): Promise<void> => {
  const metadata = await lstat(path);
  if (!metadata.isSymbolicLink() || (await readlink(path)) !== target) {
    throw new AttestCliError('run_failed', 'The eval store boundary changed during opening.', {
      path: '.attest/runs.db',
    });
  }
  await unlink(path);
};

/** Preserves native failures while ensuring cleanup failures remain throwable errors. */
const asError = (failure: unknown): Error =>
  failure instanceof Error
    ? failure
    : new Error('Eval store boundary cleanup failed.', { cause: failure });

/** Retains SQLite's captured pathname until close, then removes only the owned reverse alias. */
const retainCapturedStoreAlias = (
  store: AttestStore,
  capturedDirectory: string,
  target: string,
): AttestStore => {
  let closed = false;
  return {
    runs: store.runs,
    cache: store.cache,
    close: async () => {
      if (closed) return;
      closed = true;
      let failure: unknown;
      await store.close().catch((error: unknown) => {
        failure = error;
      });
      await removeStorePlaceholder(capturedDirectory, target).catch((error: unknown) => {
        failure ??= error;
      });
      if (failure !== undefined) throw asError(failure);
    },
  };
};

/** Atomically captures the validated .attest directory through SQLite open and migration. */
const openEvalProjectStore = async (
  projectRoot: string,
  hooks: EvalStoreBoundaryHooks = {},
): Promise<AttestStore> => {
  const storePath = await prepareEvalProjectFile(projectRoot, '.attest/runs.db', {
    createDirectories: true,
    errorCode: 'run_failed',
    message: 'The eval run store is not a safe project file.',
  });
  const directory = dirname(storePath);
  const resolvedRoot = dirname(directory);
  const captureTarget = `.attest-${randomUUID()}.opening`;
  const capturedDirectory = join(resolvedRoot, captureTarget);
  const identity = await lstat(directory);
  let moved = false;
  let placeholder = false;
  let store: AttestStore | undefined;
  let failure: unknown;
  try {
    await hooks.beforeCapture?.();
    // Atomic rename converts the validated directory identity into the path SQLite actually opens.
    await rename(directory, capturedDirectory);
    moved = true;
    if (!sameDirectoryIdentity(identity, await lstat(capturedDirectory))) {
      throw new AttestCliError('run_failed', 'The eval store boundary changed before opening.', {
        path: '.attest/runs.db',
      });
    }
    await symlink(captureTarget, directory);
    placeholder = true;
    store = await openStore(join(capturedDirectory, basename(storePath)));
    await removeStorePlaceholder(directory, captureTarget);
    placeholder = false;
    await rename(capturedDirectory, directory);
    moved = false;
    // SQLite may create or checkpoint WAL files after open, so retain its unguessable pathname.
    await symlink(basename(directory), capturedDirectory);
    return retainCapturedStoreAlias(store, capturedDirectory, basename(directory));
  } catch (error: unknown) {
    failure = error;
  }

  await store?.close().catch(() => undefined);
  if (placeholder) {
    await removeStorePlaceholder(directory, captureTarget).catch((error: unknown) => {
      failure = error;
    });
  }
  if (moved) {
    await rename(capturedDirectory, directory).catch((error: unknown) => {
      failure = error;
    });
  }
  throw asError(failure);
};

export {
  openEvalProjectStore,
  prepareEvalProjectFile,
  type EvalStoreBoundaryHooks,
  type PrepareEvalProjectFileOptions,
};
