import * as Fiber from 'effect/Fiber';
import * as Scope from 'effect/Scope';
import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import { recoverOrdinary, finishWithRelease } from '../agent/adapter/lifecycle-cause.js';
import * as Effect from 'effect/Effect';
import { performance } from 'node:perf_hooks';

import {
  parseWithSchemaSync,
  AGENT_PROTOCOL,
  type AgentRequest,
  type EvalRun,
} from '@attest/contracts';
import { type CacheStore } from '@attest/core';
import {
  CliCleanupError,
  type InvocationAttempt,
  type invokeVercelSandboxAgent,
  type InvocationResult,
} from '@attest/executor';
import {
  EvalCaseStageError,
  type CaseExecution,
  type CaseExecutionBase,
  type EvalCaseExecutionContext,
  type EvalCaseRunner,
  type EvalCaseRunnerResult,
} from '@attest/runtime';

import * as Schema from 'effect/Schema';

import { LocalError } from '../../errors/index.js';
import { assertSafeNativeAgentResource } from '../agent/authoring/resource-validation.js';
import {
  invocationOutcome,
  invokeResolvedAgent,
  startAgentRuntime,
  startupFailure,
  type AgentRuntime,
} from '../agent/adapter/invoke-resolved-agent.js';
import {
  redactAgentRequest,
  redactInvocation,
  sensitiveFieldValues,
} from '../agent/adapter/evidence-redaction.js';
import { resolveNativeAgent } from '../agent/adapter/resolve-native-agent.js';
import type { ResolvedEvalCaseInput } from './eval-resolver.js';
import { createEvalMetricEvaluator } from './eval-metric-runner.js';
import { createEvalLifecycle } from './eval-lifecycle.js';

const LIFECYCLE_ERROR_LIMIT = 4096;

const TRUNCATED_SUFFIX = ' [truncated]';

/** Appends a local lifecycle failure to fresh result and diagnostics objects. */
const appendLifecycleFailure = (
  result: EvalCaseRunnerResult,
  cause: unknown,
): EvalCaseRunnerResult => {
  const message = cause instanceof Error ? cause.message : 'The eval case lifecycle failed.';

  const messages = [
    ...new Set(
      [result.execution.diagnostics.lifecycleError, message].filter(
        (value): value is string => value !== undefined && value.length > 0,
      ),
    ),
  ];

  const combined = messages.join(' ');

  const lifecycleError =
    combined.length <= LIFECYCLE_ERROR_LIMIT
      ? combined
      : `${combined.slice(0, LIFECYCLE_ERROR_LIMIT - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;

  return {
    execution: {
      ...result.execution,
      diagnostics: { ...result.execution.diagnostics, lifecycleError },
    },
    metrics: [...result.metrics],
  };
};

/** Builds the case shape runtime consumes from one invocation, original or redacted. */
const caseExecutionFrom = (
  invocation: InvocationResult,
  base: Omit<CaseExecutionBase, 'attempts' | 'diagnostics' | 'warnings'>,
): CaseExecution => {
  const common = {
    ...base,
    attempts: invocation.attempts,
    diagnostics: invocation.diagnostics,
    warnings: invocation.warnings,
  };

  if (invocation.status === 'invocation_error') {
    return { ...common, invocationError: invocation.error, outcome: invocationOutcome(invocation) };
  }

  if (invocation.report?.ok !== true) {
    throw new LocalError(
      'internal_error',
      'Agent adapter returned an unvalidated successful response.',
    );
  }

  return {
    ...common,
    outcome: 'completed',
    response: invocation.report.value,
    trace: invocation.report.value.trace,
    warnings: invocation.report.warnings,
  };
};

/** Resolves and starts one agent runtime; session transports are reused across cases. */
const startRuntime = Effect.fn('startRuntime')(function* (
  payload: ResolvedEvalCaseInput,
  projectRoot: string,
  signal: AbortSignal,
): Effect.fn.Return<AgentRuntime, Error, Scope.Scope> {
  assertSafeNativeAgentResource(payload.agent);

  return yield* startAgentRuntime(yield* resolveNativeAgent(payload.agent, projectRoot), signal);
});

/** Builds the engine runner that reuses per-run transports and evaluates current metrics per completed case. */
const createEvalCaseRunner = Effect.fn('createEvalCaseRunner')(function* (
  projectRoot: string,
  cacheStore: CacheStore,
  run: EvalRun,
  transports: { invokeSandbox?: typeof invokeVercelSandboxAgent } = {},
): Effect.fn.Return<EvalCaseRunner<ResolvedEvalCaseInput>, never, Scope.Scope> {
  const scope = yield* Effect.scope;
  const runtimes = new Map<string, Fiber.Fiber<AgentRuntime, Error>>();
  const metricEvaluator = createEvalMetricEvaluator(projectRoot, cacheStore);
  const lifecycle = createEvalLifecycle(projectRoot, run);
  let sandboxCleanupUncertain = false;
  const sandboxReleaseCauses: Cause.Cause<Error>[] = [];

  const runtimeFor = (payload: ResolvedEvalCaseInput, signal: AbortSignal) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (sandboxCleanupUncertain)
          return yield* Effect.fail(
            new LocalError('run_failed', 'Sandbox cleanup was not confirmed.'),
          );
        let fiber = runtimes.get(payload.agent.id);

        if (fiber === undefined) {
          fiber = yield* Effect.forkIn(
            Scope.provide(startRuntime(payload, projectRoot, signal), scope),
            scope,
          );
          runtimes.set(payload.agent.id, fiber);
        }

        return yield* restore(Fiber.join(fiber));
      }),
    );

  /** Executes one case and retains raw runner evidence alongside its metric evaluations. */
  const executeCase = Effect.fn('executeCase')(function* (
    runId: string,
    resolvedCase: Parameters<EvalCaseRunner<ResolvedEvalCaseInput>['executeCase']>[1],
    signal: AbortSignal,
    context: EvalCaseExecutionContext,
  ) {
    const payload = resolvedCase.payload;

    const hookContext = {
      case_id: payload.case_id,
      test_id: payload.test_id,
      worker_index: context.workerIndex,
    };

    let workerDirectory: string | undefined;
    let outcome: CaseExecution['outcome'] | 'infrastructure_error' = 'infrastructure_error';
    let result: EvalCaseRunnerResult | undefined;

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const primary = yield* Effect.exit(
          restore(
            Effect.gen(function* () {
              workerDirectory = yield* lifecycle.prepareCase(hookContext);
              yield* lifecycle.runCasePhase('before_case', {
                context: hookContext,
                directory: workerDirectory,
                signal,
              });

              let request: AgentRequest = {
                protocol: AGENT_PROTOCOL,
                run_id: runId,
                case_id: payload.case_id,
                input: payload.case.input,
              };

              if (payload.case.params !== undefined) {
                request = { ...request, params: payload.case.params };
              }

              const startedAt = new Date().toISOString();
              const started = performance.now();
              let runtime: AgentRuntime | undefined;

              const invocation = yield* recoverOrdinary(
                Effect.gen(function* () {
                  runtime = yield* runtimeFor(payload, signal);

                  return yield* invokeResolvedAgent(runtime, request, {
                    invokeSandbox: transports.invokeSandbox,
                    agent: payload.agent,
                    attemptTimeoutMs: payload.attempt_timeout_ms,
                    projectRoot,
                    sandboxArtifactSegment: String(resolvedCase.configured_index),
                    signal,
                    workerDirectory,
                  });
                }),
                (error, cause) =>
                  Effect.succeed(startupFailure(error, performance.now() - started, cause)),
              );

              const cleanupSecrets: string[] = [];

              if (invocation.status === 'invocation_error') {
                const cause = invocation.error.cause;

                if (cause instanceof CliCleanupError && cause.attempt?.status === 'ok')
                  cleanupSecrets.push(
                    ...sensitiveFieldValues(parseWithSchemaSync(Schema.Json, cause.attempt.raw)),
                  );

                if (
                  cause instanceof Error &&
                  '_tag' in cause &&
                  cause._tag === 'SandboxAttemptCleanupError' &&
                  'cleanupCause' in cause
                ) {
                  // SAFETY: the executor's private tagged error owns this native cleanup Cause.
                  sandboxReleaseCauses.push(cause.cleanupCause as Cause.Cause<Error>);

                  if ('attempt' in cause) {
                    // SAFETY: the same private executor tag owns its completed typed attempt.
                    const completed = cause.attempt as InvocationAttempt;

                    if (completed.status === 'ok')
                      cleanupSecrets.push(
                        ...sensitiveFieldValues(parseWithSchemaSync(Schema.Json, completed.raw)),
                      );
                  }
                }
              }

              const base = {
                caseDefinition: payload.case,
                caseId: payload.case_id,
                durationMs: performance.now() - started,
                expectedMetrics: payload.metrics.map(({ metric }) => metric.id),
                startedAt,
                suiteName: payload.test_id,
              };

              // Metrics score what the agent returned. Sensitive-name redaction would turn
              // `{ token: "ok" }` into `[REDACTED]`, so only the redacted copy leaves this function.
              const original = caseExecutionFrom(invocation, { ...base, request });

              // Field-name redaction hides these values in structured evidence. Raw excerpts, stderr and
              // metric text quote the original, so they are redacted as secrets everywhere.
              const secrets = [
                ...cleanupSecrets,
                ...(runtime?.resolved.secrets ?? []),
                ...sensitiveFieldValues(
                  parseWithSchemaSync(Schema.Json, {
                    case: payload.case,
                    request,
                    response: original.outcome === 'completed' ? original.response : null,
                  }),
                ),
              ];

              let execution = caseExecutionFrom(redactInvocation(invocation, secrets), {
                ...base,
                request: redactAgentRequest(request, secrets),
              });

              outcome = execution.outcome;

              if (execution.diagnostics.sandboxCleanupConfirmed === false) {
                sandboxCleanupUncertain = true;

                const uncertainCleanup = appendLifecycleFailure(
                  { execution, metrics: [] },
                  new Error('Vercel sandbox cleanup was not confirmed.'),
                );

                execution = uncertainCleanup.execution;
              }

              Object.defineProperty(execution, 'localInvocationEvidence', { value: invocation });

              yield* recoverOrdinary(
                Effect.gen(function* () {
                  yield* lifecycle.runCasePhase('after_agent', {
                    context: hookContext,
                    directory: workerDirectory,
                    outcome: execution.outcome,
                    signal,
                  });
                  yield* context.afterAgent?.(execution) ?? Effect.void;
                }),
                (error) => Effect.fail(new EvalCaseStageError('after_agent', execution, [], error)),
              );

              const metrics = yield* metricEvaluator.evaluate({
                environment: context.environment,
                original,
                payload,
                runId,
                secrets,
                signal,
              });

              yield* recoverOrdinary(
                Effect.gen(function* () {
                  yield* lifecycle.runCasePhase('after_evaluation', {
                    context: hookContext,
                    directory: workerDirectory,
                    outcome: execution.outcome,
                    signal,
                  });
                  yield* context.afterEvaluation?.(execution, metrics) ?? Effect.void;
                }),
                (error) =>
                  Effect.fail(
                    new EvalCaseStageError('after_evaluation', execution, metrics, error),
                  ),
              );

              result = {
                execution,
                metrics,
              };

              // Internal raw cleanup receipts never enter JSON or the persisted record mapper.
              Object.defineProperty(result, 'localInvocationEvidence', { value: invocation });

              return result;
            }),
          ),
        );

        const released = yield* Effect.exit(
          lifecycle.runCasePhase('after_case', {
            context: hookContext,
            directory: workerDirectory,
            outcome,
          }),
        );

        if (Exit.isSuccess(primary) && Exit.isFailure(released)) {
          const reason = released.cause.reasons[0];

          if (
            released.cause.reasons.length === 1 &&
            reason !== undefined &&
            Cause.isFailReason(reason)
          )
            return appendLifecycleFailure(primary.value, reason.error);
        }

        return yield* finishWithRelease(primary, [released]);
      }),
    );
  });

  /** Joins acquisitions and observes every session close before the store can close. */
  const cleanup = () =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const acquired = yield* Effect.forEach([...runtimes.values()], Fiber.await);

        const releases = yield* Effect.forEach(acquired, (exit) =>
          Exit.isSuccess(exit) && exit.value.kind === 'session'
            ? Effect.exit(exit.value.session.close())
            : Effect.succeed(Exit.void),
        );

        const hooks = yield* Effect.exit(
          Effect.try({
            try: () => lifecycle.assertCleanup(),
            catch: (error) =>
              error instanceof Error ? error : new Error('Hook cleanup failed.', { cause: error }),
          }),
        );

        const sandbox = sandboxCleanupUncertain
          ? Exit.fail(
              new LocalError(
                'run_failed',
                'One or more Vercel sandbox cleanups were not confirmed.',
              ),
            )
          : Exit.void;

        const failures = [
          ...sandboxReleaseCauses.map(Exit.failCause),
          ...acquired.filter(Exit.isFailure),
          ...releases,
          hooks,
          sandbox,
        ].filter(Exit.isFailure);

        if (
          failures.length > 0 &&
          failures.every(
            (exit) => exit.cause.reasons.length === 1 && Cause.isFailReason(exit.cause.reasons[0]!),
          )
        ) {
          const errors = failures.flatMap((exit) =>
            exit.cause.reasons.flatMap((reason) =>
              Cause.isFailReason(reason) ? [reason.error] : [],
            ),
          );

          return yield* Effect.fail(new AggregateError(errors, 'Eval agent cleanup failed.'));
        }

        return yield* finishWithRelease(Exit.void, failures);
      }),
    );

  return {
    afterRun: (_runId, status, summary) => lifecycle.afterRun(status, summary),
    beforeRun: (_runId, signal) => lifecycle.beforeRun(signal),
    cleanup,
    executeCase,
  };
});

export { createEvalCaseRunner };
