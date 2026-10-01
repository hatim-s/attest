import {
  AGENT_PROTOCOL,
  type AgentRequest,
  type AgentResource,
  type JsonValue,
} from '@attest/contracts';
import { AgentInvocationError, redactTransportText, type InvocationResult } from '@attest/executor';

import { LocalError } from '../../../errors/index.js';
import { assertSafeNativeAgentResource } from '../authoring/resource-validation.js';
import {
  redactAgentRequest,
  redactAgentResponse,
  redactInvocationDiagnostics,
  redactProbeValue,
  redactStoredAttempt,
  redactTrace,
  redactWarnings,
} from './evidence-redaction.js';
import {
  invocationOutcome,
  invokeResolvedAgent,
  startAgentRuntime,
  startupFailure,
} from './invoke-resolved-agent.js';
import { resolveNativeAgent } from './resolve-native-agent.js';
import type { NativeAgentTestOptions } from './types.js';

const CONNECTION_TEST_RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const DEFAULT_TIMEOUT_MS = 60_000;

type NativeAgentConnectionResult = {
  agent_id: string;
  attempt_count: number;
  attempts: JsonValue;
  response: JsonValue;
  transport: AgentResource['transport']['kind'];
  warnings: JsonValue;
};

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

/** Runs one supported adapter probe and returns only bounded, redacted evidence. */
const testNativeAgentConnection = async (
  options: NativeAgentTestOptions,
): Promise<NativeAgentConnectionResult> => {
  assertSafeNativeAgentResource(options.agent);
  options.onProgress?.(`Testing agent ${options.agent.id}...`);
  const resolved = await resolveNativeAgent(options.agent, options.projectRoot);
  const request: AgentRequest = {
    protocol: AGENT_PROTOCOL,
    run_id: options.runId ?? CONNECTION_TEST_RUN_ID,
    case_id: 'connection-test',
    input: options.input,
  };
  if (
    resolved.kind === 'vercel_sandbox' &&
    (resolved.sandbox.artifacts?.length ?? 0) > 0 &&
    resolved.sandbox.artifact_directory === undefined
  ) {
    throw new LocalError(
      'project_invalid',
      'Sandbox artifacts require artifact_directory outside an eval worker.',
      { path: `/agents/${options.agent.id}/transport/sandbox/artifact_directory` },
    );
  }
  const startedAt = new Date().toISOString();
  const managedStartupStarted = performance.now();
  let invocation: InvocationResult;
  try {
    const runtime = await startAgentRuntime(resolved, options.signal);
    try {
      invocation = await invokeResolvedAgent(runtime, request, {
        agent: options.agent,
        attemptTimeoutMs: options.agent.timeouts?.attempt_ms ?? DEFAULT_TIMEOUT_MS,
        projectRoot: options.projectRoot,
        sandboxArtifactSegment: 'connection-test',
        signal: options.signal,
      });
    } finally {
      if (runtime.kind === 'session') await runtime.session.close();
    }
  } catch (error: unknown) {
    // A managed session's lifecycle failure is probe evidence; any other throw propagates.
    const managedSession =
      resolved.kind === 'background' ||
      resolved.kind === 'jsonl_bridge' ||
      resolved.kind === 'websocket';
    if (!(error instanceof AgentInvocationError) || !managedSession) throw error;
    invocation = startupFailure(error, performance.now() - managedStartupStarted);
  }
  if (invocation.status === 'invocation_error') {
    const code = invocation.error.code === 'cancelled' ? 'cancelled' : 'invocation_failed';
    await options.onExecution?.({
      attempts: invocation.attempts.map((attempt) =>
        redactStoredAttempt(attempt, resolved.secrets),
      ),
      caseId: request.case_id,
      diagnostics: redactInvocationDiagnostics(invocation.diagnostics, resolved.secrets),
      durationMs: invocation.durationMs,
      errorCode: invocation.error.code,
      errorMessage: redactTransportText(invocation.error.message, resolved.secrets),
      expectedMetrics: [],
      outcome: invocationOutcome(invocation),
      request: redactAgentRequest(request, resolved.secrets),
      startedAt,
      suiteName: `agent:${options.agent.id}`,
      warnings: redactWarnings(invocation.warnings, resolved.secrets),
    });
    throw new LocalError(
      code,
      `Agent connection test failed: ${redactTransportText(invocation.error.message, resolved.secrets)}`,
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
    attempts: invocation.attempts.map((attempt) => redactStoredAttempt(attempt, resolved.secrets)),
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
    agent_id: redactTransportText(options.agent.id, resolved.secrets),
    attempt_count: invocation.attempts.length,
    attempts: redactProbeValue(invocationAttempts(invocation.attempts), resolved.secrets),
    response: redactProbeValue(invocation.report.value, resolved.secrets),
    transport: options.agent.transport.kind,
    warnings: redactProbeValue(invocation.report.warnings, resolved.secrets),
  };
  options.onProgress?.(`Agent ${options.agent.id} completed.`);
  return result;
};

export { testNativeAgentConnection, type NativeAgentConnectionResult };
