import { performance } from 'node:perf_hooks';

import { AGENT_PROTOCOL, type AgentRequest, type AgentResponse } from '@attest/contracts';
import {
  AgentInvocationError,
  invokeAgent,
  invokeMappedHttpAgent,
  invokeStreamingAgent,
  startBackgroundAgent,
  startJsonlBridgeAgent,
  startWebSocketAgent,
  type CacheStore,
  type CaseExecution,
  type EvalCaseRunner,
  type InvocationResult,
} from '@attest/core';

import {
  assertSupportedProbePolicy,
  redactProbeValue,
  resolveNativeAgent,
  type ResolvedNativeAgent,
} from '../agent/native-agent-adapter.js';
import type { ResolvedEvalCaseInput } from './eval-resolver.js';
import { createEvalMetricEvaluator } from './eval-metric-runner.js';

const DEFAULT_OUTPUT_CAP_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

type RunScopedSession = {
  close(): Promise<void>;
  invoke(request: AgentRequest, signal?: AbortSignal): Promise<InvocationResult>;
};

type SessionAgent = Extract<
  ResolvedNativeAgent,
  { kind: 'background' | 'jsonl_bridge' | 'websocket' }
>;
type DirectAgent = Exclude<ResolvedNativeAgent, SessionAgent>;
type EvalAgentRuntime =
  | { kind: 'session'; resolved: SessionAgent; session: RunScopedSession }
  | { kind: 'direct'; resolved: DirectAgent };

const invocationOutcome = (
  result: Extract<InvocationResult, { status: 'invocation_error' }>,
): Exclude<CaseExecution['outcome'], 'completed'> =>
  result.error.code === 'timeout' || result.error.code === 'cancelled'
    ? result.error.code
    : 'invocation_error';

/** Converts startup throws into one bounded invocation attempt so persistence retains the failure. */
const startupFailure = (error: unknown, durationMs: number): InvocationResult => {
  const invocationError =
    error instanceof AgentInvocationError
      ? error
      : new AgentInvocationError('network', 'Agent runtime initialization failed.', {
          cause: error,
        });
  const diagnostics =
    'diagnostics' in invocationError &&
    invocationError.diagnostics !== null &&
    typeof invocationError.diagnostics === 'object'
      ? (invocationError.diagnostics as InvocationResult['diagnostics'])
      : {};
  const attempt = {
    status: 'invocation_error' as const,
    error: invocationError,
    diagnostics,
    durationMs,
    warnings: [],
  };
  return { ...attempt, attempts: [attempt] };
};

/** Redacts runtime-only secret values before evidence crosses into engine normalization or storage. */
const redactInvocation = (
  invocation: InvocationResult,
  secrets: readonly string[],
): InvocationResult => {
  const redactAttempt = (attempt: InvocationResult['attempts'][number]) => ({
    ...attempt,
    diagnostics: redactProbeValue(attempt.diagnostics, secrets) as typeof attempt.diagnostics,
    ...(attempt.rawExcerpt === undefined
      ? {}
      : { rawExcerpt: redactProbeValue(attempt.rawExcerpt, secrets) as typeof attempt.rawExcerpt }),
    warnings: redactProbeValue(attempt.warnings, secrets) as typeof attempt.warnings,
    ...(attempt.status === 'invocation_error'
      ? {
          error: new AgentInvocationError(
            attempt.error.code,
            redactProbeValue(attempt.error.message, secrets) as string,
          ),
        }
      : {}),
  });
  const attempts = invocation.attempts.map(redactAttempt);
  const terminal = redactAttempt(invocation);
  if (terminal.status === 'invocation_error') return { ...terminal, attempts };
  const report = terminal.report;
  return {
    ...terminal,
    attempts,
    ...(report?.ok === true
      ? {
          report: {
            ...report,
            value: redactProbeValue(report.value, secrets) as AgentResponse,
            warnings: redactProbeValue(report.warnings, secrets) as typeof report.warnings,
          },
        }
      : {}),
  };
};

/** Creates one run-scoped adapter session only for transports whose lifecycle benefits from reuse. */
const startRuntime = async (
  payload: ResolvedEvalCaseInput,
  projectRoot: string,
  signal: AbortSignal,
): Promise<EvalAgentRuntime> => {
  assertSupportedProbePolicy(payload.agent);
  const resolved = await resolveNativeAgent(payload.agent, projectRoot);
  switch (resolved.kind) {
    case 'background':
      return {
        kind: 'session',
        resolved,
        session: await startBackgroundAgent(resolved.agent, {
          cwd: resolved.cwd,
          env: resolved.env,
          invokeHeaders: resolved.invokeHeaders,
          invokeQuery: resolved.invokeQuery,
          secrets: resolved.secrets,
          shutdownHeaders: resolved.shutdownHeaders,
          shutdownQuery: resolved.shutdownQuery,
          signal,
        }),
      };
    case 'jsonl_bridge':
      return {
        kind: 'session',
        resolved,
        session: await startJsonlBridgeAgent(resolved.agent, {
          cwd: resolved.cwd,
          env: resolved.env,
          secrets: resolved.secrets,
          signal,
        }),
      };
    case 'websocket':
      return {
        kind: 'session',
        resolved,
        session: await startWebSocketAgent(resolved.agent, {
          headers: resolved.headers,
          secrets: resolved.secrets,
          signal,
        }),
      };
    default:
      return { kind: 'direct', resolved };
  }
};

/** Invokes the exact existing transport selected by the resolved immutable agent resource. */
const invokeRuntime = async (
  runtime: EvalAgentRuntime,
  request: AgentRequest,
  signal: AbortSignal,
  payload: ResolvedEvalCaseInput,
): Promise<InvocationResult> => {
  if (runtime.kind === 'session') return runtime.session.invoke(request, signal);
  const { resolved } = runtime;
  switch (resolved.kind) {
    case 'stream':
      return invokeStreamingAgent(resolved.agent, request, {
        headers: resolved.headers,
        query: resolved.query,
        secrets: resolved.secrets,
        signal,
      });
    case 'mapped_http':
      return invokeMappedHttpAgent(resolved.agent, request, {
        headers: resolved.headers,
        query: resolved.query,
        secrets: resolved.secrets,
        signal,
      });
    case 'direct':
      return invokeAgent(resolved.target, request, {
        env: resolved.env,
        httpHeaders: resolved.headers,
        outputCapBytes: payload.agent.limits?.response_bytes ?? DEFAULT_OUTPUT_CAP_BYTES,
        retries: payload.agent.retry?.retries ?? 0,
        signal,
        timeoutMs: payload.attempt_timeout_ms ?? DEFAULT_TIMEOUT_MS,
      });
  }
};

/** Builds the engine runner that reuses per-run transports and evaluates current metrics per completed case. */
const createEvalCaseRunner = (
  projectRoot: string,
  cacheStore: CacheStore,
): EvalCaseRunner<ResolvedEvalCaseInput> => {
  const runtimes = new Map<string, Promise<EvalAgentRuntime>>();
  const metricEvaluator = createEvalMetricEvaluator(projectRoot, cacheStore);

  const runtimeFor = (
    payload: ResolvedEvalCaseInput,
    signal: AbortSignal,
  ): Promise<EvalAgentRuntime> => {
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
  ) => {
    const payload = resolvedCase.payload;
    const request: AgentRequest = {
      protocol: AGENT_PROTOCOL,
      run_id: runId,
      case_id: payload.case_id,
      input: payload.case.input,
      ...(payload.case.params === undefined ? {} : { params: payload.case.params }),
    };
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let runtime: EvalAgentRuntime | undefined;
    let invocation: InvocationResult;
    try {
      runtime = await runtimeFor(payload, signal);
      invocation = await invokeRuntime(runtime, request, signal, payload);
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
      request: redactProbeValue(request, runtime?.resolved.secrets ?? []) as AgentRequest,
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
      throw new Error('Agent adapter returned an unvalidated successful response.');
    }
    const metrics = await metricEvaluator.evaluate(runId, payload, execution, signal);
    return { execution, metrics };
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
    if (failures.length > 0) throw new AggregateError(failures, 'Eval agent cleanup failed.');
  };

  return { cleanup, executeCase };
};

export { createEvalCaseRunner, redactInvocation };
