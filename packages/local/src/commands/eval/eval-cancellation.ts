import { finishWithRelease } from '../agent/adapter/lifecycle-cause.js';
import * as Context from 'effect/Context';
import * as Fiber from 'effect/Fiber';
import type * as Scope from 'effect/Scope';
import * as Effect from 'effect/Effect';
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
  stopPolling: Effect.Effect<void>;
};

const evalCancellationRequestSchema = stripStruct({ run_id: Schema.String, token: Schema.String });

type EvalCancellationRequest = typeof evalCancellationRequestSchema.Type;

const registryOwnershipSchema = stripStruct({ token: Schema.String });

/** One registry is provided by the process composition root and shared by all run requests. */
class CancellationRegistry extends Context.Service<
  CancellationRegistry,
  Map<string, { controller: AbortController; token: string }>
>()('attest/CancellationRegistry') {}

/** Joins one filesystem operation before cancellation can release its ownership. */
const registryIO = <A>(operation: () => Promise<A>) =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: operation,
      catch: (cause) =>
        new LocalError('run_failed', 'Eval cancellation registry operation failed.', { cause }),
    }),
  );

/** Publishes and cleans the exclusively created stage while retaining every release Exit. */
const publishRegistryFile = (temporaryPath: string, path: string, contents: string) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      let created = false;

      const primary = yield* Effect.exit(
        Effect.gen(function* () {
          yield* registryIO(() =>
            writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
          );
          created = true;
          yield* registryIO(() => rename(temporaryPath, path));
          created = false;
        }),
      );

      const cleanup = yield* Effect.exit(
        created ? registryIO(() => unlink(temporaryPath)) : Effect.void,
      );

      return yield* finishWithRelease(primary, [cleanup]);
    }),
  );

const registryKey = (projectRoot: string, runId: string): string => `${projectRoot}\0${runId}`;

/** Publishes one atomic active-run record that can be safely addressed by a separate CLI process. */
const registerEvalRun = Effect.fn('registerEvalRun')(function* (
  projectRoot: string,
  runId: string,
): Effect.fn.Return<EvalRegistryHandle, Error, CancellationRegistry | Scope.Scope> {
  const localControllers = yield* CancellationRegistry;

  const path = yield* prepareEvalProjectFile(
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

  yield* publishRegistryFile(temporaryPath, path, `${JSON.stringify(record)}\n`).pipe(
    Effect.mapError(
      (error) =>
        new LocalError('run_failed', 'Could not publish the eval cancellation registry.', {
          path: EVAL_REGISTRY_DIRECTORY,
          cause: error.cause,
        }),
    ),
  );

  const controller = new AbortController();
  const key = registryKey(projectRoot, runId);
  localControllers.set(key, { controller, token: record.token });

  const poll = Effect.gen(function* () {
    while (!controller.signal.aborted) {
      yield* Effect.sleep(25);

      const contents = yield* registryIO(() => readFile(requestPath, 'utf8')).pipe(
        Effect.orElseSucceed(() => undefined),
      );

      if (contents === undefined) continue;

      const parsed = yield* Effect.try(() =>
        parseWithSchema(evalCancellationRequestSchema, JSON.parse(contents)),
      ).pipe(Effect.orElseSucceed(() => undefined));

      if (parsed?.ok && parsed.value.run_id === runId && parsed.value.token === record.token)
        controller.abort(new Error(`Eval run ${runId} was cancelled.`));
    }
  });

  const fiber = yield* Effect.forkScoped(Effect.interruptible(poll));

  return {
    path,
    requestPath,
    record,
    signal: controller.signal,
    stopPolling: Effect.gen(function* () {
      yield* Fiber.interrupt(fiber);
      const local = localControllers.get(key);

      if (local?.token === record.token) localControllers.delete(key);
    }),
  };
}, Effect.uninterruptible);

/** Removes only the registry generation owned by this run, tolerating an already-cleaned record. */
const unregisterEvalRun = Effect.fn('unregisterEvalRun')(function* (handle: EvalRegistryHandle) {
  yield* handle.stopPolling;

  const contents = yield* registryIO(() => readFile(handle.path, 'utf8')).pipe(
    Effect.catchIf(
      (error) => errnoCode(error.cause) === 'ENOENT',
      () => Effect.succeed(undefined),
    ),
  );

  if (contents === undefined) return;

  const current = yield* Effect.try({
    try: () => parseWithSchema(registryOwnershipSchema, JSON.parse(contents)),
    catch: (cause) =>
      new LocalError('run_failed', 'Could not read eval registry ownership.', { cause }),
  });

  if (!current.ok || current.value.token !== handle.record.token) return;
  yield* registryIO(() => unlink(handle.path));
  yield* registryIO(() => unlink(handle.requestPath)).pipe(
    Effect.catchIf(
      (error) => errnoCode(error.cause) === 'ENOENT',
      () => Effect.void,
    ),
  );
}, Effect.uninterruptible);

/** Releases in-process cancellation resources while retaining uncertain durable ownership. */
const detachEvalRun = (handle: EvalRegistryHandle): Effect.Effect<void> => handle.stopPolling;

// BOUNDARY: Cancellation registry JSON is untrusted disk input; validate every record field before checking process ownership.
const parseRegistryRecord = (value: unknown, runId: string): EvalRegistryRecord | undefined => {
  const parsed = parseWithSchema(evalRegistryRecordSchema, value);

  return parsed.ok && parsed.value.run_id === runId ? parsed.value : undefined;
};

/** Publishes one authenticated run-scoped request without signalling unrelated process work. */
const signalRegisteredEvalRun = Effect.fn('signalRegisteredEvalRun')(function* (
  projectRoot: string,
  runId: string,
): Effect.fn.Return<'cancellation_requested' | 'not_active', Error, CancellationRegistry> {
  const localControllers = yield* CancellationRegistry;

  const path = yield* prepareEvalProjectFile(
    projectRoot,
    join(EVAL_REGISTRY_DIRECTORY, `${runId}.json`),
    {
      errorCode: 'run_failed',
      message: 'The eval cancellation registry is unsafe.',
    },
  );

  const contents = yield* registryIO(() => readFile(path, 'utf8')).pipe(
    Effect.orElseSucceed(() => undefined),
  );

  if (contents === undefined) return 'not_active';

  const record = yield* Effect.try(() => parseRegistryRecord(JSON.parse(contents), runId)).pipe(
    Effect.orElseSucceed(() => undefined),
  );

  if (record === undefined) return 'not_active';

  if (!(yield* isProcessPresent(record.pid))) {
    // Reconcile only the generation observed above, never a newly published replacement.
    const current = yield* registryIO(() => readFile(path, 'utf8')).pipe(
      Effect.flatMap((contents) =>
        Effect.try(() => parseRegistryRecord(JSON.parse(contents), runId)),
      ),
      Effect.orElseSucceed(() => undefined),
    );

    if (current?.token === record.token)
      yield* registryIO(() => unlink(path)).pipe(Effect.orElseSucceed(() => undefined));

    return 'not_active';
  }

  const local = localControllers.get(registryKey(projectRoot, runId));

  if (record.pid === process.pid && local?.token === record.token) {
    local.controller.abort(new Error(`Eval run ${runId} was cancelled.`));

    return 'cancellation_requested';
  }

  const requestPath = join(dirname(path), `${runId}.cancel.json`);
  const temporaryPath = `${requestPath}.${randomUUID()}.tmp`;

  yield* publishRegistryFile(
    temporaryPath,
    requestPath,
    `${JSON.stringify({ run_id: runId, token: record.token } satisfies EvalCancellationRequest)}\n`,
  );

  return 'cancellation_requested';
}, Effect.uninterruptible);

export {
  CancellationRegistry,
  detachEvalRun,
  registerEvalRun,
  signalRegisteredEvalRun,
  unregisterEvalRun,
};
