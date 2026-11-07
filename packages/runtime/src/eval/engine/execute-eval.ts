import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import { observe, ordinaryError, withEvidence } from '../lifecycle.js';
import type { EvalEvent, EvalFinalResultData } from '@attest/contracts';

import { isCleanupUncertain, safeErrorMessage } from '../errors.js';
import { withEvalHooks } from '../hooks.js';
import { createEvalJUnitPayload } from '../junit.js';
import { summarizeEvalCases } from '../normalization.js';
import type {
  EvalCaseRecord,
  EvalCaseRunner,
  EvalExecutionResult,
  EvalJUnitPayload,
  EvalPersistenceAdapter,
  EvalRunStatus,
  ExecuteEvalOptions,
  ResolvedEvalPlan,
} from '../types.js';
import { createEventCollector, MAXIMUM_EVENTS } from './event-collector.js';
import { executeCases } from './execute-cases.js';
import { expectedEventCount, validateResolvedPlan } from './plan-validation.js';
import {
  defaultTerminalFailure,
  preOrchestrationFailure,
  terminalResultFor,
} from './run-results.js';

/** Reads abort state through a call so earlier narrowing of `signal.aborted` does not stick. */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/** Facts gathered while a run executes that decide its terminal status. */
type RunStatusInputs = {
  callerCancelled: boolean;
  timedOut: boolean;
  hasCancelledCase: boolean;
  hasCaseError: boolean;
  casePersistenceConfirmed: boolean;
  cleanupConfirmed: boolean;
  infrastructureErrorCount: number;
};

/**
 * Lost case records or unconfirmed cleanup always fail a run: cancellation is not successful while
 * a runner may still own live child processes. Caller cancellation outranks other failures.
 */
const classifyRunStatus = (inputs: RunStatusInputs): EvalRunStatus => {
  if (!inputs.casePersistenceConfirmed || !inputs.cleanupConfirmed) return 'failed';

  if (inputs.callerCancelled || (!inputs.timedOut && inputs.hasCancelledCase)) return 'cancelled';

  if (inputs.timedOut || inputs.hasCaseError || inputs.infrastructureErrorCount > 0) {
    return 'failed';
  }

  return 'completed';
};

/** Requests business abort on interruption and joins the evidence owner before returning its Cause. */
const executeResolvedEvalPlan = <Payload, BaselineDiff = unknown>(
  plan: ResolvedEvalPlan<Payload>,
  runner: EvalCaseRunner<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  options: ExecuteEvalOptions<BaselineDiff, Payload> = {},
): Effect.Effect<EvalExecutionResult<Payload, BaselineDiff>, Error> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const controller = new AbortController();

      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;

      const child = yield* Effect.forkChild(
        executeOwned(plan, runner, persistence, { ...options, signal }),
        { uninterruptible: true },
      );

      const waiting = yield* Effect.exit(restore(Fiber.join(child)));

      if (Exit.isSuccess(waiting)) return waiting.value;

      if (!Cause.hasInterrupts(waiting.cause)) return yield* Effect.failCause(waiting.cause);
      controller.abort(new Error('Eval owner interrupted.'));
      const completed = yield* Fiber.await(child);

      return yield* Effect.failCause(
        withEvidence(
          Exit.isFailure(completed) ? completed.cause : waiting.cause,
          [waiting.cause],
          completed,
        ),
      );
    }),
  );

/** Runs callbacks once and records their full Causes until all persistence and release work settles. */
const executeOwned = <Payload, BaselineDiff>(
  plan: ResolvedEvalPlan<Payload>,
  caseRunner: EvalCaseRunner<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  options: ExecuteEvalOptions<BaselineDiff, Payload>,
) =>
  Effect.gen(function* () {
    const run = plan.run;
    const runner = withEvalHooks(run, caseRunner, options.hooks ?? [], options.isolation);
    const now = options.now ?? (() => new Date().toISOString());
    const terminalFailure = options.terminalFailure ?? defaultTerminalFailure;

    const early = (status: 'failed' | 'cancelled', message: string) =>
      preOrchestrationFailure<Payload, BaselineDiff>(run, {
        time: now(),
        status,
        finalResult: terminalFailure(status === 'cancelled' ? 'cancelled' : 'run_failed', message),
        onEvent: options.onEvent,
      });

    const planError =
      validateResolvedPlan(plan, run) ??
      (expectedEventCount(plan) > MAXIMUM_EVENTS
        ? 'Resolved eval plan exceeds the configured event count cap.'
        : undefined);

    if (planError) return yield* early('failed', planError);

    if (isAborted(options.signal))
      return yield* early('cancelled', 'Eval run was cancelled before orchestration started.');
    const created = yield* observe(() => persistence.createRun(run));

    if (Exit.isFailure(created)) {
      if (!ordinaryError(created.cause)) return yield* Effect.failCause(created.cause);

      return yield* early(
        'failed',
        safeErrorMessage(ordinaryError(created.cause), 'Eval run creation failed.'),
      );
    }

    const collector = createEventCollector(now, options.onEvent);
    const causes: Cause.Cause<Error>[] = [];
    const errors: string[] = [];

    const attempt = <A>(operation: () => Effect.Effect<A, Error>, fallback: string) =>
      Effect.gen(function* () {
        const exit = yield* observe(operation);

        if (Exit.isFailure(exit)) {
          causes.push(exit.cause);
          errors.push(safeErrorMessage(ordinaryError(exit.cause), fallback));
        }

        return exit;
      });

    let data: Extract<EvalEvent, { event: 'run_started' }>['data'] = {
      run_id: run.run_id,
      snapshot_hash: run.snapshot_hash,
      total_cases: plan.cases.length,
      concurrency: run.effective_command.resolved.concurrency,
      timeout_ms: run.effective_command.resolved.timeout_ms,
    };

    if (run.snapshot.selection) data = { ...data, selection: run.snapshot.selection };

    const started = yield* attempt(
      () => collector.emit({ event: 'run_started', data }),
      'Eval start event emission failed.',
    );

    if (Exit.isFailure(started)) {
      const failed = yield* early(
        'failed',
        safeErrorMessage(ordinaryError(started.cause), 'Eval start event emission failed.'),
      );

      const finalized = yield* observe(() =>
        persistence.finalizeRun(run.run_id, 'failed', failed.summary),
      );

      failed.can_release_cancellation_ownership = Exit.isSuccess(finalized);

      const all = [
        ...causes,
        ...collector.causes,
        ...(Exit.isFailure(finalized) ? [finalized.cause] : []),
      ];

      const fatal = all.find((c) => ordinaryError(c) === undefined);

      if (fatal) return yield* Effect.failCause(withEvidence(all[0] ?? fatal, all, failed));
      Object.defineProperty(failed, 'lifecycleCauses', { value: all });

      return failed;
    }

    const deadline = new AbortController();
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      deadline.abort(new Error('Eval run deadline exceeded.'));
    }, run.effective_command.resolved.timeout_ms);

    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;

    let records: EvalCaseRecord<Payload>[] = [];
    let casePersistenceConfirmed = true;
    yield* attempt(
      () =>
        Effect.gen(function* () {
          if (Exit.isFailure(started)) return;
          yield* Effect.suspend(() => runner.beforeRun?.(run.run_id, signal) ?? Effect.void);

          const state = yield* executeCases(
            run,
            plan.cases,
            runner,
            persistence,
            signal,
            collector.emit,
          );

          records = state.records;
          causes.push(...state.causes);
          errors.push(...state.infrastructureErrors);
          casePersistenceConfirmed = state.persistenceConfirmed;
        }),
      'Eval orchestration failed.',
    );
    clearTimeout(timeout);

    const cleanup = yield* attempt(
      () => runner.cleanup?.(run.run_id) ?? Effect.void,
      'Eval runner cleanup failed.',
    );

    let cleanupConfirmed = Exit.isSuccess(cleanup);
    const normalized = records.map((r) => r.normalized);
    const summary = summarizeEvalCases(normalized);

    const statusInputs = (): RunStatusInputs => ({
      callerCancelled: isAborted(options.signal),
      timedOut,
      hasCancelledCase: normalized.some((c) => c.outcome === 'cancelled'),
      hasCaseError: normalized.some((c) => c.verdict === 'error'),
      casePersistenceConfirmed,
      cleanupConfirmed,
      infrastructureErrorCount: errors.length,
    });

    let baselineDiff: BaselineDiff | undefined;
    let junit: EvalJUnitPayload | undefined;

    if (classifyRunStatus(statusInputs()) === 'completed') {
      const baselineRunId = run.effective_command.resolved.baseline_run_id;
      const baseline = options.baseline;

      if (baselineRunId !== undefined) {
        if (!baseline) errors.push('Baseline adapter is not configured.');
        else {
          const diff = yield* attempt(
            () => baseline.diffRuns({ baselineRunId, candidateRunId: run.run_id }),
            'Baseline diff failed.',
          );

          if (Exit.isSuccess(diff)) baselineDiff = diff.value;
        }
      }

      const path = run.effective_command.resolved.junit_path;
      const artifacts = options.artifacts;

      if (path !== undefined && errors.length === 0) {
        if (!artifacts) errors.push('JUnit artifact writer is not configured.');
        else {
          const published = yield* attempt(
            () =>
              Effect.gen(function* () {
                const payload = createEvalJUnitPayload(run.run_id, normalized);
                yield* artifacts.writeJUnitAtomically(path, payload);

                return payload;
              }),
            'JUnit publication failed.',
          );

          if (Exit.isSuccess(published)) junit = published.value;
        }
      }
    }

    if (collector.sinkFailure()) errors.push(collector.sinkFailure()!.message);
    let status = classifyRunStatus(statusInputs());
    let finalizationConfirmed = true;

    const reconcile = () =>
      Effect.gen(function* () {
        status = 'failed';

        const exit = yield* attempt(
          () => persistence.finalizeRun(run.run_id, status, summary),
          'Eval run failure reconciliation failed.',
        );

        if (Exit.isFailure(exit)) finalizationConfirmed = false;
      });

    const finalized = yield* attempt(
      () => persistence.finalizeRun(run.run_id, status, summary),
      'Eval run finalization failed.',
    );

    if (Exit.isFailure(finalized)) {
      finalizationConfirmed = false;
      yield* reconcile();
    }

    const after = yield* attempt(
      () => runner.afterRun?.(run.run_id, status, summary) ?? Effect.void,
      'The after_run hook failed.',
    );

    if (Exit.isFailure(after)) {
      if (isCleanupUncertain(ordinaryError(after.cause))) cleanupConfirmed = false;
      yield* reconcile();
    }

    let finalResult: EvalFinalResultData = terminalResultFor(run, summary, {
      status,
      timedOut,
      terminalFailure,
    });

    const terminal = () =>
      Effect.gen(function* () {
        yield* collector.emit({
          event: 'run_completed',
          data: { run_id: run.run_id, status, summary },
        });
        yield* collector.emit({ event: 'result', data: finalResult });
      });

    const emitted = yield* attempt(terminal, 'Eval terminal event emission failed.');

    if (Exit.isFailure(emitted)) {
      finalResult = terminalFailure('run_failed', 'Eval terminal event emission failed.');
      yield* reconcile();

      if (collector.events.at(-1)?.event === 'run_completed') collector.events.pop();
      yield* attempt(terminal, 'Eval terminal event emission failed.');
    }

    const result: EvalExecutionResult<Payload, BaselineDiff> = {
      run,
      status,
      exit_code: finalResult.exit_code,
      summary,
      cases: records,
      events: collector.events,
      final_result: finalResult,
      can_release_cancellation_ownership:
        cleanupConfirmed && finalizationConfirmed && casePersistenceConfirmed,
      baseline_diff: baselineDiff,
      junit,
    };

    causes.push(...collector.causes);
    const fatal = causes.find((c) => ordinaryError(c) === undefined);

    if (fatal) return yield* Effect.failCause(withEvidence(causes[0] ?? fatal, causes, result));
    Object.defineProperty(result, 'lifecycleCauses', { value: causes });

    return result;
  });

export { executeResolvedEvalPlan };
