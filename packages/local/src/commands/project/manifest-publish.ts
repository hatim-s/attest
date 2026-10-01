import { randomUUID } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { LocalError } from '../../errors/index.js';
import { errnoCode } from '../../internal/errno-code.js';
import { syncPath } from '../../internal/sync-path.js';

/** Publishes the empty-project manifest as one atomic, no-overwrite filesystem commit. */
const publishProjectManifest = async (root: string, contents: string): Promise<void> => {
  const manifestPath = join(root, 'attest.project.json');
  const temporaryPath = join(root, `.attest-project-${randomUUID()}.tmp`);
  let temporaryHandle;
  let directoryHandle;
  let temporaryExists = false;
  let manifestPublished = false;
  try {
    temporaryHandle = await open(temporaryPath, 'wx', 0o644);
    temporaryExists = true;
    await temporaryHandle.writeFile(contents, 'utf8');
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    // Hard-link publication fails rather than replacing a manifest created by a racing process.
    await link(temporaryPath, manifestPath);
    manifestPublished = true;
    await unlink(temporaryPath);
    temporaryExists = false;
    directoryHandle = await open(root, 'r');
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = undefined;
  } catch (error: unknown) {
    await directoryHandle?.close().catch(() => undefined);
    await temporaryHandle?.close().catch(() => undefined);
    let cleanupFailure: unknown;
    if (temporaryExists) {
      try {
        await unlink(temporaryPath);
      } catch (unlinkError: unknown) {
        if (errnoCode(unlinkError) !== 'ENOENT') cleanupFailure = unlinkError;
      }
    }
    if (manifestPublished) {
      try {
        await unlink(manifestPath);
        await syncPath(root);
      } catch (rollbackError: unknown) {
        cleanupFailure = rollbackError;
      }
    }
    if (cleanupFailure !== undefined) {
      throw new LocalError(
        'project_recovery_required',
        'Initialization failed and temporary publication state could not be removed.',
        {
          path: manifestPath,
          hint: 'Preserve the target directory and reconcile its manifest and temporary files.',
          cause: cleanupFailure,
        },
      );
    }
    if (errnoCode(error) === 'EEXIST') {
      throw new LocalError('init_conflict', 'Another process initialized this project first.', {
        path: manifestPath,
        hint: 'Inspect the existing project before retrying.',
        cause: error,
      });
    }
    throw error;
  }
};

/** Removes only the exact manifest published by this initialization attempt. */
const rollbackPublishedManifest = async (root: string, expectedContents: string): Promise<void> => {
  const manifestPath = join(root, 'attest.project.json');
  try {
    if ((await readFile(manifestPath, 'utf8')) !== expectedContents) {
      throw new LocalError(
        'project_recovery_required',
        'The published manifest changed before initialization rollback.',
        { path: manifestPath },
      );
    }
    await unlink(manifestPath);
    await syncPath(root);
  } catch (error: unknown) {
    if (errnoCode(error) !== 'ENOENT') {
      throw error;
    }
  }
};

export { publishProjectManifest, rollbackPublishedManifest };
