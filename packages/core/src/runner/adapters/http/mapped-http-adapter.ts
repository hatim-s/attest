import { parseAgentResponse, type AgentRequest } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { startTimer } from '../../internal/elapsed.js';
import type { InvocationAttempt, InvocationResult } from '../../types.js';
import { materializeHttpRequest, type ResolvedHttpRequestTemplate } from './request-template.js';
import {
  assertPollingConfiguration,
  attemptFromError,
  extractAgentResponse,
  extractRemoteJobId,
  normalizeFailure,
  requireSuccessfulStatus,
  runDirect,
  runPolling,
  withResolvedValues,
} from './mapped-http-execution.js';
import type {
  HttpAgentResource,
  MappedHttpInvokeOptions,
  TimedInvocationError,
} from './mapped-http-types.js';

const DEFAULT_ATTEMPT_MS = 60_000;
const DEFAULT_CONNECT_MS = 10_000;
const DEFAULT_FIRST_BYTE_MS = 30_000;
const DEFAULT_BODY_IDLE_MS = 30_000;
const DEFAULT_REQUEST_CAP_BYTES = 10 * 1024 * 1024;
const DEFAULT_RESPONSE_CAP_BYTES = 10 * 1024 * 1024;

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
    responseBodyTimeoutMs: agent.timeouts?.idle_ms ?? DEFAULT_BODY_IDLE_MS,
    responseCapBytes: agent.limits?.response_bytes ?? DEFAULT_RESPONSE_CAP_BYTES,
    secrets: options.secrets ?? [],
  };
  const retryAttempts: InvocationAttempt[] = [];
  let terminalAttemptDurationMs: number | undefined;
  try {
    if (signal.aborted) {
      throw new AgentInvocationError(
        options.signal?.aborted === true ? 'cancelled' : 'timeout',
        options.signal?.aborted === true
          ? 'Mapped HTTP invocation was cancelled.'
          : 'Mapped HTTP invocation timed out.',
      );
    }
    if (agent.transport.kind === 'polling') assertPollingConfiguration(agent.transport);
    const requestTemplate =
      agent.transport.kind === 'http' ? agent.transport.request : agent.transport.submit;
    const materialized = materializeHttpRequest(
      withResolvedValues(requestTemplate as ResolvedHttpRequestTemplate, options),
      request,
      agent.limits?.request_bytes ?? DEFAULT_REQUEST_CAP_BYTES,
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
    const normalized = normalizeFailure(error, signal, options.signal) as AgentInvocationError & {
      httpStatus?: number;
      rawExcerpt?: InvocationAttempt['rawExcerpt'];
    };
    const attempt = attemptFromError(
      normalized,
      (normalized as TimedInvocationError).attemptDurationMs ??
        terminalAttemptDurationMs ??
        invocationDuration(),
    );
    return { ...attempt, attempts: [...retryAttempts, attempt] };
  }
};

export { invokeMappedHttpAgent, type HttpAgentResource, type MappedHttpInvokeOptions };
