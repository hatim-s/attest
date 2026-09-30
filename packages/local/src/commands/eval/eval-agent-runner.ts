import { performance } from 'node:perf_hooks';

import { AGENT_PROTOCOL, type AgentRequest, type EvalRun } from '@attest/contracts';
import { type CacheStore } from '@attest/core';
import type { CaseExecution, InvocationResult } from '@attest/executor';
import {
  EvalCaseStageError,
  type EvalCaseExecutionContext,
  type EvalCaseRunner,
  type EvalCaseRunnerResult,
} from '@attest/runtime';

import { LocalError } from '../../errors/index.js';
import { assertSafeNativeAgentResource } from '../agent/authoring/index.js';
import {
  invocationOutcome,
  invokeResolvedAgent,
  redactAgentRequest,
  redactInvocation,
  resolveNativeAgent,
  startAgentRuntime,
  startupFailure,
  type AgentRuntime,
} from '../agent/native-agent-adapter/index.js';
import type { ResolvedEvalCaseInput } from './eval-resolver.js';
import { createEvalMetricEvaluator } from './eval-metric-runner.js';
import { createEvalLifecycle } from './eval-lifecycle.js';

const LIFECYCLE_ERROR_LIMIT = 4096;
const TRUNCATED_SUFFIX = ' [truncated]';

/** Appends a local lifecycle failure to fresh result and diagnostics objects. */
const appendLifecycleFailure = (
  result: EvalCaseRunnerResult,
  failure: unknown,
): EvalCaseRunnerResult => {
  const message = failure instanceof Error ? failure.message : 'The eval case lifecycle failed.';
  const messages = [
    ...new Set(
      [result.execution.diagnostics.lifecycleError, result.lifecycle_error, message].filter(
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
    lifecycle_error: lifecycleError,
  };
};

/** Resolves and starts one agent runtime; session transports are reused across cases. */
const startRuntime = async (
  payload: ResolvedEvalCaseInput,
  projectRoot: string,
  signal: AbortSignal,
): Promise<AgentRuntime> => {
  assertSafeNativeAgentResource(payload.agent);
  return startAgentRuntime(await resolveNativeAgent(payload.agent, projectRoot), signal);
};

/** Builds the engine runner that reuses per-run transports and evaluates current metrics per completed case. */
const createEvalCaseRunner = (
  projectRoot: string,
  cacheStore: CacheStore,
  run: EvalRun,
): EvalCaseRunner<ResolvedEvalCaseInput> => {
  const runtimes = new Map<string, Promise<AgentRuntime>>();
  const metricEvaluator = createEvalMetricEvaluator(projectRoot, cacheStore);
  const lifecycle = createEvalLifecycle(projectRoot, run);
  let sandboxCleanupUncertain = false;

  const runtimeFor = (
    payload: ResolvedEvalCaseInput,
    signal: AbortSignal,
  ): Promise<AgentRuntime> => {
    const existing = runtimes.get(payload.agent.id);
    if (existing !== undefined) return existing;
    const created = startRuntime(payload, projectRoot, signal);
    runtimes.set(payload.agent.id, created);
    return created;
  };

  /** Executes one case and retains raw runner evidence alongside its metric evaluations. */
  const executeCase = async (
    runId: string,
    resolvedCase: Parameters<EvalCaseRunner<ResolvedEvalCaseInput>['executeCase']>[1],
    signal: AbortSignal,
    context: EvalCaseExecutionContext,
  ) => {
    const payload = resolvedCase.payload;
    const hookContext = {
      case_id: payload.case_id,
      test_id: payload.test_id,
      worker_index: context.worker_index,
    };
    let workerDirectory: string | undefined;
    let outcome = 'infrastructure_error';
    let result: EvalCaseRunnerResult | undefined;
    let failure: unknown;
    try {
      workerDirectory = await lifecycle.prepareCase(hookContext);
      await lifecycle.runCasePhase('before_case', {
        context: hookContext,
        directory: workerDirectory,
        signal,
      });
      const request: AgentRequest = {
        protocol: AGENT_PROTOCOL,
        run_id: runId,
        case_id: payload.case_id,
        input: payload.case.input,
        ...(payload.case.params === undefined ? {} : { params: payload.case.params }),
      };
      const startedAt = new Date().toISOString();
      const started = performance.now();
      let runtime: AgentRuntime | undefined;
      let invocation: InvocationResult;
      try {
        runtime = await runtimeFor(payload, signal);
        invocation = await invokeResolvedAgent(runtime, request, {
          agent: payload.agent,
          attemptTimeoutMs: payload.attempt_timeout_ms,
          projectRoot,
          sandboxArtifactSegment: String(resolvedCase.configured_index),
          signal,
          workerDirectory,
        });
      } catch (error: unknown) {
        invocation = startupFailure(error, performance.now() - started);
      }
      const redacted = redactInvocation(invocation, runtime?.resolved.secrets ?? []);
      const common = {
        attempts: redacted.attempts,
        caseDefinition: payload.case,
        caseId: payload.case_id,
        diagnostics: redacted.diagnostics,
        durationMs: performance.now() - started,
        expectedMetrics: payload.metrics.map(({ metric }) => metric.id),
        request: redactAgentRequest(request, runtime?.resolved.secrets ?? []),
        startedAt,
        suiteName: payload.test_id,
        warnings: redacted.warnings,
      };
      let execution: CaseExecution;
      if (redacted.status === 'invocation_error') {
        execution = {
          ...common,
          invocationError: redacted.error,
          outcome: invocationOutcome(redacted),
        };
      } else if (redacted.report?.ok === true) {
        execution = {
          ...common,
          outcome: 'completed',
          response: redacted.report.value,
          ...('trace' in redacted.report.value && redacted.report.value.trace !== undefined
            ? { trace: redacted.report.value.trace }
            : {}),
          warnings: redacted.report.warnings,
        };
      } else {
        throw new LocalError(
          'internal_error',
          'Agent adapter returned an unvalidated successful response.',
        );
      }
      outcome = execution.outcome;
      let lifecycleError: string | undefined;
      if (execution.diagnostics.sandboxCleanupConfirmed === false) {
        sandboxCleanupUncertain = true;
        const uncertainCleanup = appendLifecycleFailure(
          { execution, metrics: [] },
          new Error('Vercel sandbox cleanup was not confirmed.'),
        );
        execution = uncertainCleanup.execution;
        lifecycleError = uncertainCleanup.lifecycle_error;
      }
      try {
        await lifecycle.runCasePhase('after_agent', {
          context: hookContext,
          directory: workerDirectory,
          outcome: execution.outcome,
          signal,
        });
        await context.afterAgent?.(execution);
      } catch (error: unknown) {
        throw new EvalCaseStageError('after_agent', execution, [], error);
      }
      const metrics = await metricEvaluator.evaluate(runId, payload, execution, signal);
      try {
        await lifecycle.runCasePhase('after_evaluation', {
          context: hookContext,
          directory: workerDirectory,
          outcome: execution.outcome,
          signal,
        });
        await context.afterEvaluation?.(execution, metrics);
      } catch (error: unknown) {
        throw new EvalCaseStageError('after_evaluation', execution, metrics, error);
      }
      result = {
        execution,
        metrics,
        ...(lifecycleError === undefined ? {} : { lifecycle_error: lifecycleError }),
      };
    } catch (error: unknown) {
      failure = error;
    }

    try {
      await lifecycle.runCasePhase('after_case', {
        context: hookContext,
        directory: workerDirectory,
        outcome,
      });
    } catch (hookError: unknown) {
      if (result !== undefined) {
        result = appendLifecycleFailure(result, hookError);
      } else if (failure instanceof EvalCaseStageError) {
        failure = new EvalCaseStageError(
          failure.stage,
          failure.execution,
          failure.metrics,
          new AggregateError([failure.cause, hookError], 'Eval case lifecycle hooks failed.'),
        );
      } else {
        failure = new AggregateError(
          failure === undefined ? [hookError] : [failure, hookError],
          'Case execution and after_case hook failed.',
        );
      }
    }

    if (failure instanceof Error) throw failure;
    if (failure !== undefined) {
      throw new Error('Eval case execution failed.', { cause: failure });
    }
    if (result === undefined) throw new Error('Eval runner returned no case result.');
    return result;
  };

  /** Closes every started per-run transport and reports all cleanup failures together. */
  const cleanup = async (): Promise<void> => {
    const settledRuntimes = await Promise.allSettled(runtimes.values());
    const sessions = settledRuntimes.flatMap((result) =>
      result.status === 'fulfilled' && result.value.kind === 'session'
        ? [result.value.session]
        : [],
    );
    const closed = await Promise.allSettled(sessions.map((session) => session.close()));
    const failures: unknown[] = [];
    for (const result of settledRuntimes) {
      if (result.status === 'rejected') failures.push(result.reason as unknown);
    }
    for (const result of closed) {
      if (result.status === 'rejected') failures.push(result.reason as unknown);
    }
    try {
      lifecycle.assertCleanup();
    } catch (error: unknown) {
      failures.push(error);
    }
    if (sandboxCleanupUncertain) {
      failures.push(
        new LocalError('run_failed', 'One or more Vercel sandbox cleanups were not confirmed.'),
      );
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Eval agent cleanup failed.');
  };

  return {
    afterRun: (_runId, status, summary) => lifecycle.afterRun(status, summary),
    beforeRun: (_runId, signal) => lifecycle.beforeRun(signal),
    cleanup,
    executeCase,
  };
};

export { createEvalCaseRunner };
