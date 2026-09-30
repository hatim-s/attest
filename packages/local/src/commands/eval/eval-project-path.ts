import { randomUUID } from 'node:crypto';
import { lstat, readlink, rename, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { AttestStore } from '@attest/core';

import { LocalError, type LocalErrorCode } from '../../errors/index.js';
import { openStore } from '../../store/index.js';
import { resolveContainedPath } from '../../project/project-path.js';

type PrepareEvalProjectFileOptions = {
  allowAbsolute?: boolean;
  createDirectories?: boolean;
  errorCode: LocalErrorCode;
  message: string;
};

/**
 * Resolves one project-controlled file for eval state or output, creating missing parent
 * directories when asked. Every failure, including filesystem errors, becomes the caller's
 * error so no path detail beyond the configured value reaches the user.
 */
const prepareEvalProjectFile = async (
  projectRoot: string,
  configuredPath: string,
  options: PrepareEvalProjectFileOptions,
): Promise<string> => {
  const unsafe = (): LocalError =>
    new LocalError(options.errorCode, options.message, { path: configuredPath });
  try {
    return await resolveContainedPath(projectRoot, configuredPath, {
      allowAbsolute: options.allowAbsolute,
      createDirectories: options.createDirectories,
      expect: 'file',
      problem: unsafe,
    });
  } catch (error: unknown) {
    if (error instanceof LocalError) throw error;
    throw unsafe();
  }
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
    throw new LocalError('run_failed', 'The eval store boundary changed during opening.', {
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
const openEvalProjectStore = async (projectRoot: string): Promise<AttestStore> => {
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
    // Atomic rename converts the validated directory identity into the path SQLite actually opens.
    await rename(directory, capturedDirectory);
    moved = true;
    if (!sameDirectoryIdentity(identity, await lstat(capturedDirectory))) {
      throw new LocalError('run_failed', 'The eval store boundary changed before opening.', {
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

export { openEvalProjectStore, prepareEvalProjectFile, type PrepareEvalProjectFileOptions };
