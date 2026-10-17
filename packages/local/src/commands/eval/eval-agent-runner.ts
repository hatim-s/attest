import { performance } from 'node:perf_hooks';

import { AGENT_PROTOCOL, type AgentRequest, type EvalRun } from '@attest/contracts';
import { type CacheStore } from '@attest/core';
import type { invokeVercelSandboxAgent, InvocationResult } from '@attest/executor';
import {
  EvalCaseStageError,
  type CaseExecution,
  type CaseExecutionBase,
  type EvalCaseExecutionContext,
  type EvalCaseRunner,
  type EvalCaseRunnerResult,
} from '@attest/runtime';

import { LocalError } from '../../errors/index.js';
import { assertSafeNativeAgentResource } from '../agent/authoring/resource-validation.js';
import {
  invocationOutcome,
  invokeResolvedAgent,
  startAgentRuntime,
  startupFailure,
  type AgentRuntime,
} from '../agent/adapter/invoke-resolved-agent.js';
import { redactAgentRequest, redactInvocation } from '../agent/adapter/evidence-redaction.js';
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
  transports: { invokeSandbox?: typeof invokeVercelSandboxAgent } = {},
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
      worker_index: context.workerIndex,
    };

    let workerDirectory: string | undefined;
    let outcome = 'infrastructure_error';
    let result: EvalCaseRunnerResult | undefined;
    let failure: Error | undefined;

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
      };

      if (payload.case.params !== undefined) {
        request.params = payload.case.params;
      }

      const startedAt = new Date().toISOString();
      const started = performance.now();
      let runtime: AgentRuntime | undefined;
      let invocation: InvocationResult;

      try {
        runtime = await runtimeFor(payload, signal);
        invocation = await invokeResolvedAgent(runtime, request, {
          invokeSandbox: transports.invokeSandbox,
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

      const secrets = runtime?.resolved.secrets ?? [];

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

      const metrics = await metricEvaluator.evaluate({
        original,
        payload,
        runId,
        secrets,
        signal,
      });

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
      };
    } catch (error: unknown) {
      failure =
        error instanceof Error ? error : new Error('Eval case execution failed.', { cause: error });
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
      if (result.status === 'rejected') failures.push(result.reason);
    }

    for (const result of closed) {
      if (result.status === 'rejected') failures.push(result.reason);
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
