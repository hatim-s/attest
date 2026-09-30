import { parseAgentResponse, type AgentRequest } from '@attest/contracts';

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
  assertPollingConfiguration,
  attemptFromError,
  extractAgentResponse,
  extractRemoteJobId,
  normalizeFailure,
  requireSuccessfulStatus,
  runDirect,
  runPolling,
} from './mapped-http-execution.js';
import type { HttpAgentResource, MappedHttpInvokeOptions } from './mapped-http-types.js';

/** Invokes a direct or polling mapped HTTP resource as one bounded Attest attempt. */
const invokeMappedHttpAgent = async (
  agent: HttpAgentResource,
  request: AgentRequest,
  options: MappedHttpInvokeOptions = {},
): Promise<InvocationResult> => {
  const invocationDuration = startTimer();
  const timeoutSignal = AbortSignal.timeout(agent.timeouts?.attempt_ms ?? DEFAULT_ATTEMPT_MS);
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
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
    if (agent.transport.kind === 'polling') assertPollingConfiguration(agent.transport);
    const requestTemplate =
      agent.transport.kind === 'http' ? agent.transport.request : agent.transport.submit;
    const materialized = materializeHttpRequest(
      resolveRequestTemplate(requestTemplate, options),
      request,
      agent.limits?.request_bytes ?? DEFAULT_REQUEST_BYTES,
    );
    const completed =
      agent.transport.kind === 'http'
        ? await runDirect(
            agent as Parameters<typeof runDirect>[0],
            request,
            materialized,
            policy,
            signal,
            retryAttempts,
          )
        : await runPolling(
            agent as Parameters<typeof runPolling>[0],
            request,
            materialized,
            policy,
            signal,
            retryAttempts,
          );
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
