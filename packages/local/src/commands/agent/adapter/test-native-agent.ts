import * as Effect from 'effect/Effect';
import { recoverOrdinary, finishWithRelease } from './lifecycle-cause.js';
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

type ConnectionAttemptEvidence = {
  attempt: number;
  duration_ms: number;
  status: InvocationResult['status'];
  diagnostics: JsonValue;
  warnings: JsonValue;
  invocation_code?: string;
  raw_excerpt?: JsonValue;
};

const invocationAttempts = (attempts: InvocationResult['attempts']): JsonValue =>
  attempts.map((attempt, index) => {
    const evidence: ConnectionAttemptEvidence = {
      attempt: index + 1,
      duration_ms: attempt.durationMs,
      status: attempt.status,
      diagnostics: redactProbeValue(attempt.diagnostics, []),
      warnings: redactProbeValue(attempt.warnings, []),
    };

    if (attempt.status === 'invocation_error') evidence.invocation_code = attempt.error.code;

    if (attempt.rawExcerpt !== undefined)
      evidence.raw_excerpt = redactProbeValue(attempt.rawExcerpt, []);

    return evidence;
  });

/** Runs one supported adapter probe and returns only bounded, redacted evidence. */
const testNativeAgentConnection = Effect.fn('testNativeAgentConnection')(function* (
  options: Omit<NativeAgentTestOptions, 'onExecution'> & {
    onExecution?: (
      execution: import('@attest/core').StoredCaseExecution,
    ) => Effect.Effect<void, Error>;
  },
) {
  try {
    assertSafeNativeAgentResource(options.agent);
    options.onProgress?.(`Testing agent ${options.agent.id}...`);

    const resolved = yield* resolveNativeAgent(options.agent, options.projectRoot);

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

    const invocation = yield* recoverOrdinary(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* startAgentRuntime(resolved, options.signal);

          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const primary = yield* Effect.exit(
                restore(
                  invokeResolvedAgent(runtime, request, {
                    agent: options.agent,
                    attemptTimeoutMs: options.agent.timeouts?.attempt_ms ?? DEFAULT_TIMEOUT_MS,
                    projectRoot: options.projectRoot,
                    sandboxArtifactSegment: 'connection-test',
                    signal: options.signal,
                  }),
                ),
              );

              const release = yield* Effect.exit(
                runtime.kind === 'session' ? runtime.session.close() : Effect.void,
              );

              return yield* finishWithRelease(primary, [release]);
            }),
          );
        }),
      ),
      (error, cause) => {
        const managedSession =
          resolved.kind === 'background' ||
          resolved.kind === 'jsonl_bridge' ||
          resolved.kind === 'websocket';

        return error instanceof AgentInvocationError && managedSession
          ? Effect.succeed(startupFailure(error, performance.now() - managedStartupStarted))
          : Effect.failCause(cause);
      },
    );

    if (invocation.status === 'invocation_error') {
      const code = invocation.error.code === 'cancelled' ? 'cancelled' : 'invocation_failed';
      yield* options.onExecution?.({
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
      }) ?? Effect.void;
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

    yield* options.onExecution?.({
      attempts: invocation.attempts.map((attempt) =>
        redactStoredAttempt(attempt, resolved.secrets),
      ),
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
    }) ?? Effect.void;

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
  } catch (error) {
    if (error instanceof LocalError) return yield* Effect.fail(error);
    throw error;
  }
});

export { testNativeAgentConnection, type NativeAgentConnectionResult };
