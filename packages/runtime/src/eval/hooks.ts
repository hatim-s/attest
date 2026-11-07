import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import type { EvalRun } from '@attest/contracts';
import { EvalCaseStageError, isCleanupUncertain } from './errors.js';
import { observe, ordinaryError, withEvidence, exitError, retainCauses } from './lifecycle.js';
import type {
  EvalCaseHookContext,
  EvalCaseIsolation,
  EvalCaseRunner,
  EvalCaseRunnerResult,
  EvalHookContexts,
  EvalHooks,
} from './types.js';

const LIFECYCLE_ERROR_LIMIT = 4096;

const TRUNCATED_SUFFIX = ' [truncated]';

/** Flattens nested lifecycle failures into stable diagnostics without discarding earlier evidence. */
const lifecycleErrorMessages = (cause: unknown): string[] => {
  if (cause instanceof AggregateError && cause.errors.length > 0) {
    return cause.errors.flatMap(lifecycleErrorMessages);
  }

  return [cause instanceof Error ? cause.message : 'Eval case lifecycle failed.'];
};

/** Joins distinct lifecycle messages within the persisted diagnostics limit. */
const boundedLifecycleError = (messages: readonly string[]): string => {
  const message = [...new Set(messages)].join(' ');

  if (message.length <= LIFECYCLE_ERROR_LIMIT) {
    return message;
  }

  return `${message.slice(0, LIFECYCLE_ERROR_LIMIT - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
};

/** Returns fresh evidence objects with every lifecycle failure represented in diagnostics. */
const withLifecycleFailures = (
  result: EvalCaseRunnerResult,
  failures: readonly unknown[],
): EvalCaseRunnerResult => {
  const existing = result.execution.diagnostics.lifecycleError;

  const messages = [
    ...(existing === undefined ? [] : [existing]),
    ...failures.flatMap(lifecycleErrorMessages),
  ].filter((message) => message.length > 0);

  const lifecycleError = messages.length === 0 ? undefined : boundedLifecycleError(messages);

  return {
    execution: {
      ...result.execution,
      diagnostics: { ...result.execution.diagnostics, lifecycleError },
    },
    metrics: [...result.metrics],
  };
};

/** Owns ordered hooks and the environment until every case finalization step settles. */
const withEvalHooks = <Payload>(
  run: Readonly<EvalRun>,
  runner: EvalCaseRunner<Payload>,
  hooks: readonly EvalHooks<Payload>[],
  isolation?: EvalCaseIsolation,
): EvalCaseRunner<Payload> => {
  const cleanupFailures: Cause.Cause<Error>[] = [];
  let runSignal = new AbortController().signal;

  const latch = (cause: Cause.Cause<Error>) => {
    if (
      cause.reasons.some((reason) => Cause.isFailReason(reason) && isCleanupUncertain(reason.error))
    )
      cleanupFailures.push(cause);
  };

  const dispatch = <Stage extends keyof EvalHookContexts<Payload>>(
    stage: Stage,
    context: EvalHookContexts<Payload>[Stage],
  ) =>
    Effect.gen(function* () {
      for (const hook of hooks) yield* Effect.suspend(() => hook[stage]?.(context) ?? Effect.void);
    });

  /** Final stages attempt every hook, retaining defects alongside ordinary release failures. */
  const dispatchSettled = <Stage extends keyof EvalHookContexts<Payload>>(
    stage: Stage,
    context: EvalHookContexts<Payload>[Stage],
  ) =>
    Effect.gen(function* () {
      const failures: Cause.Cause<Error>[] = [];

      for (const hook of hooks) {
        const exit = yield* observe(() => hook[stage]?.(context) ?? Effect.void);

        if (Exit.isFailure(exit)) failures.push(exit.cause);
      }

      if (failures.length)
        return yield* Effect.failCause(Cause.fromReasons(failures.flatMap((c) => c.reasons)));
    });

  return {
    beforeRun: (runId, signal) =>
      Effect.gen(function* () {
        runSignal = signal;

        const exit = yield* observe(() =>
          Effect.gen(function* () {
            yield* dispatch('before_run', { run, signal });
            yield* Effect.suspend(() => runner.beforeRun?.(runId, signal) ?? Effect.void);
          }),
        );

        if (Exit.isFailure(exit)) {
          latch(exit.cause);

          return yield* Effect.failCause(exit.cause);
        }
      }),
    executeCase: (runId, resolvedCase, signal, worker) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const context: EvalCaseHookContext<Payload> = {
            run,
            signal,
            resolvedCase,
            workerIndex: worker.workerIndex,
          };

          const primary = yield* Effect.exit(
            restore(
              Effect.gen(function* () {
                if (isolation)
                  context.environment = yield* Effect.suspend(() =>
                    isolation({
                      runId,
                      caseId: resolvedCase.case_id,
                      testId: resolvedCase.test_id,
                      configuredIndex: resolvedCase.configured_index,
                      workerIndex: worker.workerIndex,
                      signal,
                    }),
                  );
                yield* dispatch('before_case', context);

                return yield* Effect.suspend(() =>
                  runner.executeCase(runId, resolvedCase, signal, {
                    ...worker,
                    environment: context.environment,
                    afterAgent: (execution) => dispatch('after_agent', { ...context, execution }),
                    afterEvaluation: (execution, metrics) =>
                      dispatch('after_evaluation', { ...context, execution, metrics }),
                  }),
                );
              }),
            ),
          );

          if (Exit.isFailure(primary)) latch(primary.cause);
          const error = Exit.isFailure(primary) ? ordinaryError(primary.cause) : undefined;

          const result = Exit.isSuccess(primary)
            ? primary.value
            : error instanceof EvalCaseStageError
              ? { execution: error.execution, metrics: error.metrics }
              : undefined;

          const releases: Cause.Cause<Error>[] = [];

          const finalSteps = [
            () => context.environment?.beginFinalization() ?? Effect.void,
            () =>
              dispatchSettled('after_case', {
                ...context,
                result,
                error: error ?? (Exit.isFailure(primary) ? primary.cause : undefined),
              }),
            () => context.environment?.dispose() ?? Effect.void,
          ];

          for (const [index, step] of finalSteps.entries()) {
            const exit = yield* observe(step);

            if (Exit.isFailure(exit)) {
              releases.push(exit.cause);
              latch(exit.cause);

              if (index === 2) cleanupFailures.push(exit.cause);
            }
          }

          // Defects and interruption retain their primary Cause after all releases have been observed.
          if (Exit.isFailure(primary) && error === undefined)
            return yield* Effect.failCause(withEvidence(primary.cause, releases, result));
          const fatalRelease = releases.find((c) => ordinaryError(c) === undefined);

          if (fatalRelease)
            return yield* Effect.failCause(
              withEvidence(
                Exit.isFailure(primary) ? primary.cause : fatalRelease,
                releases,
                result,
              ),
            );

          if (result)
            return retainCauses(
              withLifecycleFailures(result, [
                ...(error instanceof EvalCaseStageError ? [error.cause] : []),
                ...releases.map((c) => ordinaryError(c)),
              ]),
              [...(Exit.isFailure(primary) ? [primary.cause] : []), ...releases],
            );

          return yield* Exit.isFailure(primary)
            ? Effect.failCause(withEvidence(primary.cause, releases))
            : primary;
        }),
      ),
    cleanup: (runId) =>
      Effect.gen(function* () {
        const exit = yield* observe(() => runner.cleanup?.(runId) ?? Effect.void);
        const failures = [...cleanupFailures, ...(Exit.isFailure(exit) ? [exit.cause] : [])];

        if (failures.length) {
          const error = Object.assign(
            new AggregateError(
              failures.map((c) => ordinaryError(c) ?? c),
              'Eval cleanup failed.',
            ),
            { cleanupConfirmed: false },
          );

          const fatal = failures.find((c) => ordinaryError(c) === undefined);

          return yield* Effect.failCause(withEvidence(fatal ?? Cause.fail(error), failures));
        }
      }),
    afterRun: (runId, status, summary) =>
      Effect.gen(function* () {
        const first = yield* observe(
          () => runner.afterRun?.(runId, status, summary) ?? Effect.void,
        );

        const second = yield* observe(() =>
          dispatchSettled('after_run', { run, signal: runSignal, status, summary }),
        );

        const failures = [first, second].filter(Exit.isFailure);

        if (failures.length) {
          const fatal = failures.find((e) => ordinaryError(e.cause) === undefined);

          const error = Object.assign(
            new AggregateError(failures.map(exitError), 'Eval after_run hooks failed.'),
            {
              cleanupConfirmed: !failures.some((e) => isCleanupUncertain(exitError(e))),
            },
          );

          return yield* Effect.failCause(
            withEvidence(
              fatal?.cause ?? Cause.fail(error),
              failures.map((e) => e.cause),
            ),
          );
        }
      }),
  };
};

export { withEvalHooks };
