import { resolve } from 'node:path';

import {
  AGENT_PROTOCOL,
  type AgentRequest,
  type AgentResource,
  type JsonValue,
} from '@attest/contracts';
import { type StoredAttempt } from '@attest/core';
import {
  AgentInvocationError,
  invokeAgent,
  invokeMappedHttpAgent,
  invokeStreamingAgent,
  invokeVercelSandboxAgent,
  redactTransportText,
  startBackgroundAgent,
  startJsonlBridgeAgent,
  startWebSocketAgent,
  type InvocationResult,
} from '@attest/runtime';

import { LocalError } from '../../../errors/index.js';
import {
  REDACTED,
  redactAgentRequest,
  redactAgentResponse,
  redactInvocationDiagnostics,
  redactProbeValue,
  redactStoredAttempt,
  redactTrace,
  redactWarnings,
} from './evidence-redaction.js';
import { resolveNativeAgent } from './resolve-native-agent.js';
import type { NativeAgentTestOptions } from './types.js';

const CONNECTION_TEST_RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const DEFAULT_OUTPUT_CAP_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

type NativeAgentConnectionResult = {
  agent_id: string;
  attempt_count: number;
  attempts: JsonValue;
  response: JsonValue;
  transport: AgentResource['transport']['kind'];
  warnings: JsonValue;
};

const assertSupportedProbePolicy = (agent: AgentResource): void => {
  const kind = agent.transport.kind;
  const unsupportedTimeoutFields =
    kind === 'native_cli'
      ? ['connect_ms', 'first_byte_ms', 'idle_ms', 'run_ms']
      : kind === 'http' || kind === 'polling'
        ? ['run_ms']
        : kind === 'jsonl_bridge'
          ? ['connect_ms']
          : [];
  const unsupportedTimeout = unsupportedTimeoutFields.find(
    (field) =>
      agent.timeouts?.[field as keyof NonNullable<AgentResource['timeouts']>] !== undefined,
  );
  if (unsupportedTimeout !== undefined) {
    throw new LocalError('project_invalid', 'This timeout phase is not supported by the adapter.', {
      path: `/agents/${agent.id}/timeouts/${unsupportedTimeout}`,
      hint: 'Remove the unsupported phase or select a lifecycle that owns it.',
    });
  }
  if (
    (kind === 'native_cli' && agent.retry !== undefined && agent.retry.backoff.kind !== 'none') ||
    (kind === 'jsonl_bridge' && (agent.retry?.retries ?? 0) > 0)
  ) {
    throw new LocalError('project_invalid', 'Retry backoff is not supported by native probes.', {
      path: `/agents/${agent.id}/retry/backoff`,
      hint:
        kind === 'jsonl_bridge'
          ? 'Set retries to zero; sent bridge requests are not replayed.'
          : 'Use deterministic no-backoff retries for a native connection probe.',
    });
  }
  const unsupportedLimitFields =
    kind === 'native_cli'
      ? ['request_bytes', 'event_count', 'event_bytes', 'total_evidence_bytes']
      : kind === 'http' || kind === 'polling'
        ? ['event_count', 'event_bytes', 'total_evidence_bytes']
        : kind === 'background_cli'
          ? ['event_count', 'event_bytes']
          : kind === 'stream'
            ? ['response_bytes']
            : [];
  const unsupportedLimit = unsupportedLimitFields.find(
    (field) => agent.limits?.[field as keyof NonNullable<AgentResource['limits']>] !== undefined,
  );
  if (unsupportedLimit !== undefined) {
    throw new LocalError(
      'project_invalid',
      'This evidence limit is not supported by the adapter.',
      {
        path: `/agents/${agent.id}/limits/${unsupportedLimit}`,
        hint: 'Remove the limit or use the adapter-specific request, response, or event cap.',
      },
    );
  }
};

const redactString = (value: string, secrets: readonly string[]): string =>
  redactTransportText(value, secrets);

const invocationAttempts = (attempts: InvocationResult['attempts']): JsonValue =>
  attempts.map((attempt, index) => ({
    attempt: index + 1,
    duration_ms: attempt.durationMs,
    status: attempt.status,
    ...(attempt.status === 'invocation_error' ? { invocation_code: attempt.error.code } : {}),
    diagnostics: attempt.diagnostics,
    raw_excerpt: attempt.rawExcerpt,
    warnings: attempt.warnings,
  })) as JsonValue;

const storedAttempts = (
  attempts: InvocationResult['attempts'],
  secrets: readonly string[],
): StoredAttempt[] => attempts.map((attempt) => redactStoredAttempt(attempt, secrets));

/** Runs one supported adapter probe and returns only bounded, redacted evidence. */
const testNativeAgentConnection = async (
  options: NativeAgentTestOptions,
): Promise<NativeAgentConnectionResult> => {
  assertSupportedProbePolicy(options.agent);
  options.onProgress?.(`Testing agent ${options.agent.id}...`);
  const resolved = await resolveNativeAgent(
    options.agent,
    options.projectRoot,
    options.secretFileObserver,
  );
  const request: AgentRequest = {
    protocol: AGENT_PROTOCOL,
    run_id: options.runId ?? CONNECTION_TEST_RUN_ID,
    case_id: 'connection-test',
    input: options.input,
  };
  const startedAt = new Date().toISOString();
  let invocation: InvocationResult;
  const managedStartupStarted = performance.now();
  try {
    switch (resolved.kind) {
      case 'background': {
        const session = await startBackgroundAgent(resolved.agent, {
          cwd: resolved.cwd,
          env: resolved.env,
          invokeHeaders: resolved.invokeHeaders,
          invokeQuery: resolved.invokeQuery,
          secrets: resolved.secrets,
          shutdownHeaders: resolved.shutdownHeaders,
          shutdownQuery: resolved.shutdownQuery,
          signal: options.signal,
        });
        try {
          invocation = await session.invoke(request, options.signal);
        } finally {
          await session.close();
        }
        break;
      }
      case 'jsonl_bridge': {
        const session = await startJsonlBridgeAgent(resolved.agent, {
          cwd: resolved.cwd,
          env: resolved.env,
          secrets: resolved.secrets,
          signal: options.signal,
        });
        try {
          invocation = await session.invoke(request, options.signal);
        } finally {
          await session.close();
        }
        break;
      }
      case 'stream':
        invocation = await invokeStreamingAgent(resolved.agent, request, {
          headers: resolved.headers,
          query: resolved.query,
          secrets: resolved.secrets,
          signal: options.signal,
        });
        break;
      case 'websocket': {
        const session = await startWebSocketAgent(resolved.agent, {
          headers: resolved.headers,
          secrets: resolved.secrets,
          signal: options.signal,
        });
        try {
          invocation = await session.invoke(request, options.signal);
        } finally {
          await session.close();
        }
        break;
      }
      case 'mapped_http':
        invocation = await invokeMappedHttpAgent(resolved.agent, request, {
          headers: resolved.headers,
          query: resolved.query,
          secrets: resolved.secrets,
          signal: options.signal,
        });
        break;
      case 'vercel_sandbox': {
        if (
          (resolved.sandbox.artifacts?.length ?? 0) > 0 &&
          resolved.sandbox.artifact_directory === undefined
        ) {
          throw new LocalError(
            'project_invalid',
            'Sandbox artifacts require artifact_directory outside an eval worker.',
            { path: `/agents/${options.agent.id}/transport/sandbox/artifact_directory` },
          );
        }
        const attemptTimeoutMs = options.agent.timeouts?.attempt_ms ?? DEFAULT_TIMEOUT_MS;
        const retries = options.agent.retry?.retries ?? 0;
        invocation = await invokeVercelSandboxAgent(
          resolved.sandbox,
          {
            argv: resolved.argv,
            ...(resolved.cwd === undefined ? {} : { cwd: resolved.cwd }),
            env: resolved.env,
            attemptTimeoutMs,
            retries,
            responseBytes: options.agent.limits?.response_bytes ?? DEFAULT_OUTPUT_CAP_BYTES,
            sandboxTimeoutMs: Math.min(
              Number.MAX_SAFE_INTEGER,
              attemptTimeoutMs * (retries + 1) + 60_000,
            ),
          },
          request,
          {
            projectRoot: options.projectRoot,
            ...(resolved.sandbox.artifact_directory === undefined
              ? {}
              : {
                  artifactRoot: resolve(
                    options.projectRoot,
                    resolved.sandbox.artifact_directory,
                    request.run_id,
                    'connection-test',
                  ),
                }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        );
        break;
      }
      case 'direct':
        invocation = await invokeAgent(resolved.target, request, {
          env: resolved.env,
          httpHeaders: resolved.headers,
          outputCapBytes: options.agent.limits?.response_bytes ?? DEFAULT_OUTPUT_CAP_BYTES,
          retries: options.agent.retry?.retries ?? 0,
          signal: options.signal,
          timeoutMs: options.agent.timeouts?.attempt_ms ?? DEFAULT_TIMEOUT_MS,
        });
        break;
    }
  } catch (error: unknown) {
    if (
      !(error instanceof AgentInvocationError) ||
      (resolved.kind !== 'background' &&
        resolved.kind !== 'jsonl_bridge' &&
        resolved.kind !== 'websocket')
    ) {
      throw error;
    }
    const diagnostics =
      'diagnostics' in error && error.diagnostics !== null && typeof error.diagnostics === 'object'
        ? (error.diagnostics as InvocationResult['diagnostics'])
        : {};
    const attempt = {
      status: 'invocation_error' as const,
      error,
      diagnostics,
      durationMs: performance.now() - managedStartupStarted,
      warnings: [],
    };
    invocation = { ...attempt, attempts: [attempt] };
  }
  if (invocation.status === 'invocation_error') {
    const code = invocation.error.code === 'cancelled' ? 'cancelled' : 'invocation_failed';
    await options.onExecution?.({
      attempts: storedAttempts(invocation.attempts, resolved.secrets),
      caseId: request.case_id,
      diagnostics: redactInvocationDiagnostics(invocation.diagnostics, resolved.secrets),
      durationMs: invocation.durationMs,
      errorCode: invocation.error.code,
      errorMessage: redactString(invocation.error.message, resolved.secrets),
      expectedMetrics: [],
      outcome:
        invocation.error.code === 'cancelled'
          ? 'cancelled'
          : invocation.error.code === 'timeout'
            ? 'timeout'
            : 'invocation_error',
      request: redactAgentRequest(request, resolved.secrets),
      startedAt,
      suiteName: `agent:${options.agent.id}`,
      warnings: redactWarnings(invocation.warnings, resolved.secrets),
    });
    throw new LocalError(
      code,
      `Agent connection test failed: ${redactString(invocation.error.message, resolved.secrets)}`,
      {
        hint:
          code === 'cancelled'
            ? 'Retry when cancellation is no longer required.'
            : 'Repair the agent mapping or transport and retry `attest agent test`.',
        details: redactProbeValue(
          {
            attempt_count: invocation.attempts.length,
            attempts: invocationAttempts(invocation.attempts),
            diagnostics: invocation.diagnostics,
            invocation_code: invocation.error.code,
            raw_excerpt: invocation.rawExcerpt,
          },
          resolved.secrets,
        ),
      },
    );
  }
  if (invocation.report === undefined || !invocation.report.ok) {
    throw new LocalError('internal_error', 'The adapter omitted its parse report.');
  }

  await options.onExecution?.({
    attempts: storedAttempts(invocation.attempts, resolved.secrets),
    caseId: request.case_id,
    diagnostics: redactInvocationDiagnostics(invocation.diagnostics, resolved.secrets),
    durationMs: invocation.durationMs,
    expectedMetrics: [],
    outcome: 'completed',
    request: redactAgentRequest(request, resolved.secrets),
    response: redactAgentResponse(invocation.report.value, resolved.secrets),
    startedAt,
    suiteName: `agent:${options.agent.id}`,
    trace:
      invocation.report.value.trace === undefined
        ? undefined
        : redactTrace(invocation.report.value.trace, resolved.secrets),
    warnings: redactWarnings(invocation.warnings, resolved.secrets),
  });

  const result: NativeAgentConnectionResult = {
    agent_id: redactString(options.agent.id, resolved.secrets),
    attempt_count: invocation.attempts.length,
    attempts: redactProbeValue(invocationAttempts(invocation.attempts), resolved.secrets),
    response: redactProbeValue(invocation.report.value, resolved.secrets),
    transport: options.agent.transport.kind,
    warnings: redactProbeValue(invocation.report.warnings, resolved.secrets),
  };
  options.onProgress?.(`Agent ${options.agent.id} completed.`);
  return result;
};

export {
  CONNECTION_TEST_RUN_ID,
  REDACTED,
  assertSupportedProbePolicy,
  redactProbeValue,
  testNativeAgentConnection,
  type NativeAgentConnectionResult,
};
