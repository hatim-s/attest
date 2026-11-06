import { stripStruct } from '@attest/contracts';
import { parseWithSchema } from '@attest/contracts';
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as Schema from 'effect/Schema';

import { errnoCode } from '../../internal/errno-code.js';
import { isProcessPresent } from '../../internal/process-presence.js';
import { LocalError } from '../../errors/index.js';
import { prepareEvalProjectFile } from './eval-project-path.js';

const EVAL_REGISTRY_DIRECTORY = join('.attest', 'eval-runs');

const evalRegistryRecordSchema = stripStruct({
  pid: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
  ).check(Schema.isGreaterThan(0)),
  run_id: Schema.String,
  token: Schema.String.check(Schema.isMinLength(1)),
});

type EvalRegistryRecord = typeof evalRegistryRecordSchema.Type;

type EvalRegistryHandle = {
  path: string;
  requestPath: string;
  record: EvalRegistryRecord;
  signal: AbortSignal;
  stopPolling: () => void;
};

const evalCancellationRequestSchema = stripStruct({ run_id: Schema.String, token: Schema.String });

type EvalCancellationRequest = typeof evalCancellationRequestSchema.Type;

const registryOwnershipSchema = stripStruct({ token: Schema.String });

const localControllers = new Map<string, { controller: AbortController; token: string }>();

const registryKey = (projectRoot: string, runId: string): string => `${projectRoot}\0${runId}`;

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
    throw new LocalError('run_failed', 'Could not publish the eval cancellation registry.', {
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
      const request = parseWithSchema(
        evalCancellationRequestSchema,
        JSON.parse(await readFile(requestPath, 'utf8')),
      );

      if (request.ok && request.value.run_id === runId && request.value.token === record.token) {
        controller.abort(new Error(`Eval run ${runId} was cancelled.`));

        return;
      }
    } catch {
      // A missing or malformed request cannot authenticate, so leave the owned run active.
    }

    schedulePoll();
  };

  const schedulePoll = (): void => {
    // Detached on purpose: poll handles its own failures and reschedules itself.
    timer = setTimeout(() => void poll(), 25);
    timer.unref();
  };

  schedulePoll();

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
    const current = parseWithSchema(
      registryOwnershipSchema,
      JSON.parse(await readFile(handle.path, 'utf8')),
    );

    if (current.ok && current.value.token === handle.record.token) {
      await Promise.all([
        unlink(handle.path),
        unlink(handle.requestPath).catch((cause: unknown) => {
          if (errnoCode(cause) !== 'ENOENT') throw cause;
        }),
      ]);
    }
  } catch (error: unknown) {
    if (errnoCode(error) !== 'ENOENT') {
      throw new LocalError('run_failed', 'Could not clean the eval cancellation registry.', {
        path: EVAL_REGISTRY_DIRECTORY,
        cause: error,
      });
    }
  }
};

/** Releases in-process cancellation resources while retaining uncertain durable ownership. */
const detachEvalRun = (handle: EvalRegistryHandle): void => handle.stopPolling();

// BOUNDARY: Cancellation registry JSON is untrusted disk input; validate every record field before checking process ownership.
const parseRegistryRecord = (value: unknown, runId: string): EvalRegistryRecord | undefined => {
  const parsed = parseWithSchema(evalRegistryRecordSchema, value);

  return parsed.ok && parsed.value.run_id === runId ? parsed.value : undefined;
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
    record = parseRegistryRecord(JSON.parse(await readFile(path, 'utf8')), runId);
  } catch (error: unknown) {
    if (errnoCode(error) === 'ENOENT') return 'not_active';
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
    throw new LocalError('run_failed', 'Could not signal the active eval process.', {
      path: runId,
      cause: error,
    });
  }
};

export { detachEvalRun, registerEvalRun, signalRegisteredEvalRun, unregisterEvalRun };
