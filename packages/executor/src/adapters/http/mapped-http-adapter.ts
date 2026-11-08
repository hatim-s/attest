import * as Effect from 'effect/Effect';
import { withHttpSignal } from './http-effects.js';
import {
  parseAgentResponse,
  tryOwned,
  type AgentRequest,
  type AgentResource,
} from '@attest/contracts';

import { AgentInvocationError, abortedError } from '../../errors.js';
import {
  DEFAULT_ATTEMPT_MS,
  DEFAULT_CONNECT_MS,
  DEFAULT_FIRST_BYTE_MS,
  DEFAULT_IDLE_MS,
  DEFAULT_REQUEST_BYTES,
  DEFAULT_RESPONSE_BYTES,
} from '../../internal/agent-defaults.js';
import { startTimer } from '../../internal/elapsed.js';
import type { InvocationAttempt, InvocationResult } from '../../types.js';
import { materializeHttpRequest, resolveRequestTemplate } from './request-template.js';
import {
  attemptFromError,
  extractAgentResponse,
  extractRemoteJobId,
  runDirect,
} from './mapped-http-execution.js';
import { runPolling } from './mapped-http-polling.js';
import type { HttpJsonTransport } from './http-client.js';

/** An agent reached over plain HTTP, either answering directly or through submit-and-poll. */
type HttpAgentResource = AgentResource & {
  transport: Extract<AgentResource['transport'], { kind: 'http' | 'polling' }>;
};

/** Runtime-resolved request values and cancellation for one mapped HTTP invocation. */
type MappedHttpInvokeOptions = {
  /** Overrides Node DNS-pinned I/O with a host-owned guarded transport. */
  requestJson?: HttpJsonTransport;
  /** Limits retries regardless of the authored resource policy. Zero forbids replay. */
  retries?: number;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  secrets?: readonly string[];
  /** The caller's cancellation; its abort is recorded as `cancelled`. */
  signal?: AbortSignal;
  /** An extra deadline owned by an enclosing session; its abort is recorded as `timeout`. */
  deadlineSignal?: AbortSignal;
};

/** Invokes a direct or polling mapped HTTP resource as one bounded Attest attempt. */
const invokeMappedHttpAgent = Effect.fn('http.invokeMapped')(function* (
  agent: HttpAgentResource,
  request: AgentRequest,
  options: MappedHttpInvokeOptions = {},
): Effect.fn.Return<InvocationResult, AgentInvocationError> {
  const invocationDuration = startTimer();

  return yield* withHttpSignal(
    agent.timeouts?.attempt_ms ?? DEFAULT_ATTEMPT_MS,
    [options.signal, options.deadlineSignal],
    (signal) =>
      Effect.gen(function* () {
        const policy = {
          attemptSignal: signal,
          callerSignal: options.signal,
          connectTimeoutMs: agent.timeouts?.connect_ms ?? DEFAULT_CONNECT_MS,
          firstByteTimeoutMs: agent.timeouts?.first_byte_ms ?? DEFAULT_FIRST_BYTE_MS,
          responseBodyTimeoutMs: agent.timeouts?.idle_ms ?? DEFAULT_IDLE_MS,
          responseCapBytes: agent.limits?.response_bytes ?? DEFAULT_RESPONSE_BYTES,
          secrets: options.secrets ?? [],
        };

        const retryAttempts: InvocationAttempt[] = [];
        let terminalAttemptDurationMs: number | undefined;

        const operation = Effect.gen(function* () {
          if (signal.aborted)
            return yield* Effect.fail(abortedError(options.signal, 'Mapped HTTP invocation'));

          const requestTemplate =
            agent.transport.kind === 'http' ? agent.transport.request : agent.transport.submit;

          const materialized = yield* tryOwned(AgentInvocationError, () =>
            materializeHttpRequest(
              resolveRequestTemplate(requestTemplate, options),
              request,
              agent.limits?.request_bytes ?? DEFAULT_REQUEST_BYTES,
            ),
          );

          const retry =
            options.retries === undefined
              ? agent.retry
              : {
                  backoff: agent.retry?.backoff ?? { kind: 'none' as const },
                  retries: options.retries,
                };

          const context = {
            retry,
            policy,
            signal,
            retryAttempts,
            requestJson: options.requestJson,
          };

          const { transport } = agent;

          const completed =
            transport.kind === 'http'
              ? yield* runDirect(materialized, context)
              : yield* runPolling(transport, request, materialized, context);

          terminalAttemptDurationMs = completed.durationMs;

          if (!completed.ok) {
            const attempt = attemptFromError(completed.error, completed.durationMs);

            return { ...attempt, attempts: [...retryAttempts, attempt] };
          }

          const { response } = completed;

          const remoteJobId =
            completed.remoteJobId ??
            (yield* tryOwned(AgentInvocationError, () =>
              extractRemoteJobId(response.raw, agent.transport.extraction.remote_job_id_pointer),
            ));

          const normalized = yield* tryOwned(AgentInvocationError, () =>
            extractAgentResponse(response.raw, agent.transport.extraction, options.secrets ?? []),
          );

          const report = parseAgentResponse(normalized);

          if (!report.ok) {
            return yield* Effect.fail(
              new AgentInvocationError(
                'invalid_envelope',
                'Mapped HTTP extraction is not a valid agent response.',
              ),
            );
          }

          const attempt: InvocationAttempt = {
            status: 'ok',
            raw: normalized,
            report,
            diagnostics: {
              httpStatus: response.status,
            },
            durationMs: completed.durationMs,
            rawExcerpt: response.rawExcerpt,
            warnings: report.warnings,
          };

          if (remoteJobId !== undefined) attempt.diagnostics.remoteJobId = remoteJobId;

          return { ...attempt, attempts: [...retryAttempts, attempt] };
        });

        return yield* operation.pipe(
          Effect.catch((normalized) =>
            Effect.sync(() => {
              const attempt = attemptFromError(
                normalized,
                terminalAttemptDurationMs ?? invocationDuration(),
              );

              return { ...attempt, attempts: [...retryAttempts, attempt] };
            }),
          ),
        );
      }),
  );
});

export { invokeMappedHttpAgent, type HttpAgentResource, type MappedHttpInvokeOptions };
