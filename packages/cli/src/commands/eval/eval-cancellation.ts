import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { AttestCliError } from '../../errors.js';
import { prepareEvalProjectFile } from './eval-project-path.js';

const EVAL_REGISTRY_DIRECTORY = join('.attest', 'eval-runs');

type EvalRegistryRecord = {
  pid: number;
  run_id: string;
  token: string;
};

type EvalRegistryHandle = {
  path: string;
  requestPath: string;
  record: EvalRegistryRecord;
  signal: AbortSignal;
  stopPolling: () => void;
};

type EvalCancellationRequest = {
  run_id: string;
  token: string;
};

const localControllers = new Map<string, { controller: AbortController; token: string }>();
const registryKey = (projectRoot: string, runId: string): string => `${projectRoot}\0${runId}`;

const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;

/** Checks liveness without delivering a process-wide cancellation signal. */
const isProcessPresent = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return getErrorCode(error) === 'EPERM';
  }
};

/** Publishes one atomic active-run record that can be safely addressed by a separate CLI process. */
const registerEvalRun = async (projectRoot: string, runId: string): Promise<EvalRegistryHandle> => {
  const path = await prepareEvalProjectFile(
    projectRoot,
    join(EVAL_REGISTRY_DIRECTORY, `${runId}.json`),
    {
      createDirectories: true,
      errorCode: 'run_failed',
      message: 'The eval cancellation registry is unsafe.',
    },
  );
  const directory = dirname(path);
  const record: EvalRegistryRecord = {
    pid: process.pid,
    run_id: runId,
    token: randomUUID(),
  };
  const requestPath = join(directory, `${runId}.cancel.json`);
  const temporaryPath = join(directory, `.${runId}.${record.token}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new AttestCliError('run_failed', 'Could not publish the eval cancellation registry.', {
      path: EVAL_REGISTRY_DIRECTORY,
      cause: error,
    });
  }
  const controller = new AbortController();
  const key = registryKey(projectRoot, runId);
  localControllers.set(key, { controller, token: record.token });
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  /** Polls only this run's authenticated request file for cross-process cancellation. */
  const poll = async (): Promise<void> => {
    if (stopped || controller.signal.aborted) return;
    try {
      const request = JSON.parse(
        await readFile(requestPath, 'utf8'),
      ) as Partial<EvalCancellationRequest>;
      if (request.run_id === runId && request.token === record.token) {
        controller.abort(new Error(`Eval run ${runId} was cancelled.`));
        return;
      }
    } catch (error: unknown) {
      if (getErrorCode(error) !== 'ENOENT') {
        // A malformed request cannot authenticate, so leave the owned run active.
      }
    }
    timer = setTimeout(() => void poll(), 25);
    timer.unref();
  };
  timer = setTimeout(() => void poll(), 25);
  timer.unref();
  return {
    path,
    requestPath,
    record,
    signal: controller.signal,
    stopPolling: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      const local = localControllers.get(key);
      if (local?.token === record.token) localControllers.delete(key);
    },
  };
};

/** Removes only the registry generation owned by this run, tolerating an already-cleaned record. */
const unregisterEvalRun = async (handle: EvalRegistryHandle): Promise<void> => {
  handle.stopPolling();
  try {
    const current = JSON.parse(await readFile(handle.path, 'utf8')) as Partial<EvalRegistryRecord>;
    if (current.token === handle.record.token) {
      await Promise.all([
        unlink(handle.path),
        unlink(handle.requestPath).catch((error: unknown) => {
          if (getErrorCode(error) !== 'ENOENT') throw error;
        }),
      ]);
    }
  } catch (error: unknown) {
    if (getErrorCode(error) !== 'ENOENT') {
      throw new AttestCliError('run_failed', 'Could not clean the eval cancellation registry.', {
        path: EVAL_REGISTRY_DIRECTORY,
        cause: error,
      });
    }
  }
};

/** Releases in-process cancellation resources while retaining uncertain durable ownership. */
const detachEvalRun = (handle: EvalRegistryHandle): void => handle.stopPolling();

const parseRegistryRecord = (value: unknown, runId: string): EvalRegistryRecord | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<EvalRegistryRecord>;
  return candidate.run_id === runId &&
    Number.isInteger(candidate.pid) &&
    (candidate.pid ?? 0) > 0 &&
    typeof candidate.token === 'string' &&
    candidate.token.length > 0
    ? (candidate as EvalRegistryRecord)
    : undefined;
};

/** Publishes one authenticated run-scoped request without signalling unrelated process work. */
const signalRegisteredEvalRun = async (
  projectRoot: string,
  runId: string,
): Promise<'cancellation_requested' | 'not_active'> => {
  const path = await prepareEvalProjectFile(
    projectRoot,
    join(EVAL_REGISTRY_DIRECTORY, `${runId}.json`),
    {
      errorCode: 'run_failed',
      message: 'The eval cancellation registry is unsafe.',
    },
  );
  let record: EvalRegistryRecord | undefined;
  try {
    record = parseRegistryRecord(JSON.parse(await readFile(path, 'utf8')) as unknown, runId);
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') return 'not_active';
  }
  if (record === undefined) return 'not_active';
  if (!isProcessPresent(record.pid)) {
    await unlink(path).catch(() => undefined);
    return 'not_active';
  }

  const local = localControllers.get(registryKey(projectRoot, runId));
  if (record.pid === process.pid && local?.token === record.token) {
    local.controller.abort(new Error(`Eval run ${runId} was cancelled.`));
    return 'cancellation_requested';
  }

  const requestPath = join(dirname(path), `${runId}.cancel.json`);
  const temporaryPath = `${requestPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ run_id: runId, token: record.token } satisfies EvalCancellationRequest)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    await rename(temporaryPath, requestPath);
    return 'cancellation_requested';
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new AttestCliError('run_failed', 'Could not signal the active eval process.', {
      path: runId,
      cause: error,
    });
  }
};

export {
  detachEvalRun,
  EVAL_REGISTRY_DIRECTORY,
  registerEvalRun,
  signalRegisteredEvalRun,
  unregisterEvalRun,
  type EvalRegistryHandle,
};
