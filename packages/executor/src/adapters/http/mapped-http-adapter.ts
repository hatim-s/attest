import { parseAgentResponse, type AgentRequest, type AgentResource } from '@attest/contracts';

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
  normalizeFailure,
  requireSuccessfulStatus,
  runDirect,
} from './mapped-http-execution.js';
import { runPolling } from './mapped-http-polling.js';

/** An agent reached over plain HTTP, either answering directly or through submit-and-poll. */
type HttpAgentResource = AgentResource & {
  transport: Extract<AgentResource['transport'], { kind: 'http' | 'polling' }>;
};

/** Runtime-resolved request values and cancellation for one mapped HTTP invocation. */
type MappedHttpInvokeOptions = {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  secrets?: readonly string[];
  /** The caller's cancellation; its abort is recorded as `cancelled`. */
  signal?: AbortSignal;
  /** An extra deadline owned by an enclosing session; its abort is recorded as `timeout`. */
  deadlineSignal?: AbortSignal;
};

/** Invokes a direct or polling mapped HTTP resource as one bounded Attest attempt. */
const invokeMappedHttpAgent = async (
  agent: HttpAgentResource,
  request: AgentRequest,
  options: MappedHttpInvokeOptions = {},
): Promise<InvocationResult> => {
  const invocationDuration = startTimer();
  const signal = AbortSignal.any(
    [
      AbortSignal.timeout(agent.timeouts?.attempt_ms ?? DEFAULT_ATTEMPT_MS),
      options.signal,
      options.deadlineSignal,
    ].filter((candidate) => candidate !== undefined),
  );
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
  try {
    if (signal.aborted) throw abortedError(options.signal, 'Mapped HTTP invocation');
    const requestTemplate =
      agent.transport.kind === 'http' ? agent.transport.request : agent.transport.submit;
    const materialized = materializeHttpRequest(
      resolveRequestTemplate(requestTemplate, options),
      request,
      agent.limits?.request_bytes ?? DEFAULT_REQUEST_BYTES,
    );
    const context = { retry: agent.retry, policy, signal, retryAttempts };
    const { transport } = agent;
    const completed =
      transport.kind === 'http'
        ? await runDirect(materialized, context)
        : await runPolling(transport, request, materialized, context);
    terminalAttemptDurationMs = completed.durationMs;
    const { response } = completed;
    requireSuccessfulStatus(response);
    const remoteJobId =
      completed.remoteJobId ??
      extractRemoteJobId(response.raw, agent.transport.extraction.remote_job_id_pointer);
    const normalized = extractAgentResponse(
      response.raw,
      agent.transport.extraction,
      options.secrets ?? [],
    );
    const report = parseAgentResponse(normalized);
    if (!report.ok) {
      throw new AgentInvocationError(
        'invalid_envelope',
        'Mapped HTTP extraction is not a valid agent response.',
      );
    }
    const attempt: InvocationAttempt = {
      status: 'ok',
      raw: normalized,
      report,
      diagnostics: {
        httpStatus: response.status,
        ...(remoteJobId === undefined ? {} : { remoteJobId }),
      },
      durationMs: completed.durationMs,
      rawExcerpt: response.rawExcerpt,
      warnings: report.warnings,
    };
    return { ...attempt, attempts: [...retryAttempts, attempt] };
  } catch (error: unknown) {
    const normalized = normalizeFailure(error, signal, options.signal);
    const attempt = attemptFromError(
      normalized,
      normalized.attemptDurationMs ?? terminalAttemptDurationMs ?? invocationDuration(),
    );
    return { ...attempt, attempts: [...retryAttempts, attempt] };
  }
};

export { invokeMappedHttpAgent, type HttpAgentResource, type MappedHttpInvokeOptions };
