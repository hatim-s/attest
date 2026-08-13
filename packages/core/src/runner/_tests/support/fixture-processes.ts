import { execFileSync } from 'node:child_process';
import { open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const FIXTURE_PROCESS_SWEEP_LOCK_PATH = join(tmpdir(), 'attest-runner-fixture-sweep.lock');
const FIXTURE_PROCESS_SWEEP_LOCK_TIMEOUT_MS = 30_000;

/**
 * Leak-proof backstop for hostile test fixtures: teardown must never depend on a PID the fixture
 * may not have published, because readiness can fail before the PID file is written.
 */
const sweepFixtureProcesses = (markers: readonly string[]): number[] => {
  let processSnapshot: string;
  try {
    processSnapshot = execFileSync('ps', ['-Ao', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 5_000,
    });
  } catch {
    return [];
  }

  const processIds = processSnapshot.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    const processIdText = match?.[1];
    const processCommand = match?.[2];
    if (processIdText === undefined || processCommand === undefined) return [];

    return markers.some((marker) => processCommand.includes(marker)) ? [Number(processIdText)] : [];
  });

  for (const processId of processIds) {
    try {
      process.kill(-processId, 'SIGKILL');
    } catch {
      // A process group may already be gone or unavailable to this test worker.
    }

    try {
      process.kill(processId, 'SIGKILL');
    } catch {
      // The group signal commonly reaps the leader before this best-effort fallback.
    }
  }

  return processIds;
};

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

export { acquireFixtureProcessSweepLock, sweepFixtureProcesses };
