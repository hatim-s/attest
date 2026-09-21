import { open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const FIXTURE_PROCESS_SWEEP_LOCK_PATH = join(tmpdir(), 'attest-runner-fixture-sweep.lock');
const FIXTURE_PROCESS_SWEEP_LOCK_TIMEOUT_MS = 30_000;

const isFileExistsError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'EEXIST';

/**
 * Serializes suites that use global process-name sweeps so one suite cannot reap another's live
 * fixture before that fixture has completed its own assertions.
 *
 * Waiting is best-effort by design: a worker killed mid-sweep would otherwise leave a lock file
 * that fails every later suite, so an expired wait proceeds unlocked (racing a sweep is recoverable,
 * refusing to clean up is not) and takes the stale lock over.
 */
const acquireFixtureProcessSweepLock = async (): Promise<() => Promise<void>> => {
  let ownsLock = false;
  const releaseLock = async (): Promise<void> => {
    if (ownsLock) await rm(FIXTURE_PROCESS_SWEEP_LOCK_PATH, { force: true });
  };

  const deadline = Date.now() + FIXTURE_PROCESS_SWEEP_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const lock = await open(FIXTURE_PROCESS_SWEEP_LOCK_PATH, 'wx');
      await lock.close();
      ownsLock = true;
      return releaseLock;
    } catch (error) {
      if (!isFileExistsError(error)) {
        return releaseLock;
      }
    }

    await wait(25);
  }

  return releaseLock;
};

export { acquireFixtureProcessSweepLock };
