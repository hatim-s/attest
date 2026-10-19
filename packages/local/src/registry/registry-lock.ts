import { open, rm } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

import { LocalError } from '../errors/index.js';
import { errnoCode } from '../internal/errno-code.js';
import { createPrivateAncestors } from '../internal/private-file.js';

const RETRY_INTERVAL_MS = 20;

const LOCK_TIMEOUT_MS = 10_000;

/** Creates the lock file exclusively, retrying while another process holds it. */
const acquireLock = async (lockPath: string): Promise<void> => {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      await (await open(lockPath, 'wx', 0o600)).close();

      return;
    } catch (cause: unknown) {
      if (errnoCode(cause) !== 'EEXIST' || Date.now() >= deadline) throw cause;
      await setTimeout(RETRY_INTERVAL_MS);
    }
  }
};

/**
 * Runs one read-modify-write of the registry while holding `<registryPath>.lock`, so concurrent
 * `attest init` and `attest projects` calls each see the previous write. A process that dies
 * while holding the lock leaves the file behind; later updates wait ten seconds, then fail with
 * a hint to delete it.
 */
const withRegistryLock = async <T>(registryPath: string, update: () => Promise<T>): Promise<T> => {
  const lockPath = `${registryPath}.lock`;

  try {
    await createPrivateAncestors(lockPath);
    await acquireLock(lockPath);
  } catch (cause: unknown) {
    throw new LocalError('registry_write_failed', 'Could not lock the project registry.', {
      path: lockPath,
      hint:
        errnoCode(cause) === 'EEXIST'
          ? `Another Attest command is updating the registry. If none is running, delete ${lockPath} and retry.`
          : 'Check that the registry directory is writable and that no parent is a symbolic link, then retry.',
      cause,
    });
  }

  try {
    return await update();
  } finally {
    await rm(lockPath, { force: true });
  }
};

export { withRegistryLock };
