import {
  parseAgentResponse,
  WEBSOCKET_EVIDENCE_SCHEMA_ID,
  type AgentRequest,
  type AgentResponse,
  type JsonValue,
  type WebSocketAttemptEvidence,
  type WebSocketErrorClassification,
} from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { startTimer } from '../../internal/elapsed.js';
import { createRawExcerpt } from '../../internal/raw-excerpt.js';
import type { InvocationAttempt, InvocationResult } from '../../types.js';
import { redactEventEvidence, redactTransportText } from '../http/redaction.js';
import type { WebSocketClose, WebSocketConnection } from './websocket-connection.js';
import type { WebSocketAgentResource } from './websocket-protocol.js';

const DEFAULT_EVENT_COUNT = 1_024;
const DEFAULT_TOTAL_EVIDENCE_BYTES = 10 * 1024 * 1024;

type EvidenceEvent = WebSocketAttemptEvidence['events'][number];

/** Mutable state for one request while it crosses attempts and connections. */
type PendingInvocation = {
  acknowledged: boolean;
  attemptTimer?: NodeJS.Timeout;
  attempts: InvocationAttempt[];
  callerAbort?: () => void;
  close?: WebSocketClose;
  connection?: WebSocketConnection;
  duration: () => number;
  events: EvidenceEvent[];
  idleTimer?: NodeJS.Timeout;
  messageCount: number;
  request: AgentRequest;
  requestId: string;
  resolve: (result: InvocationResult) => void;
  retriesUsed: number;
  signal?: AbortSignal;
  totalEvidenceBytes: number;
  trace?: JsonValue;
};

const notAcknowledged = {
  state: 'not_acknowledged',
  retry: 'allowed',
  reconnect: 'allowed',
  replay: 'allowed',
} as const;
const acknowledged = {
  state: 'acknowledged',
  retry: 'forbidden',
  reconnect: 'forbidden',
  replay: 'forbidden',
} as const;

/** Creates the mutable state for a request before its first transport attempt. */
const createPendingInvocation = (
  request: AgentRequest,
  requestId: string,
  resolve: (result: InvocationResult) => void,
  signal?: AbortSignal,
): PendingInvocation => ({
  acknowledged: false,
  attempts: [],
  duration: startTimer(),
  events: [],
  messageCount: 0,
  request,
  requestId,
  resolve,
  retriesUsed: 0,
  signal,
  totalEvidenceBytes: 0,
});

/** Clears attempt timers and detaches the caller abort listener. */
const clearPendingTimers = (pending: PendingInvocation): void => {
  if (pending.attemptTimer !== undefined) clearTimeout(pending.attemptTimer);
  if (pending.idleTimer !== undefined) clearTimeout(pending.idleTimer);
  if (pending.callerAbort !== undefined) {
    pending.signal?.removeEventListener('abort', pending.callerAbort);
  }
  pending.attemptTimer = undefined;
  pending.idleTimer = undefined;
  pending.callerAbort = undefined;
};

/** Resets per-attempt state while retaining the request id and prior evidence. */
const beginRetry = (pending: PendingInvocation): void => {
  clearPendingTimers(pending);
  pending.acknowledged = false;
  pending.trace = undefined;
  pending.duration = startTimer();
  pending.events = [];
  pending.messageCount = 0;
  pending.totalEvidenceBytes = 0;
};

/** Accounts for an incoming message before any evidence content is retained. */
const countMessage = (
  agent: WebSocketAgentResource,
  pending: PendingInvocation,
  bytes: number,
): boolean => {
  pending.messageCount += 1;
  pending.totalEvidenceBytes += bytes;
  return (
    pending.messageCount <= (agent.limits?.event_count ?? DEFAULT_EVENT_COUNT) &&
    pending.totalEvidenceBytes <=
      (agent.limits?.total_evidence_bytes ?? DEFAULT_TOTAL_EVIDENCE_BYTES)
  );
};

/** Records bounded, redacted evidence for one transport event. */
const recordEvent = (
  agent: WebSocketAgentResource,
  pending: PendingInvocation,
  secrets: readonly string[],
  classification: EvidenceEvent['classification'],
  messageBytes?: number,
  source?: string,
  raw?: unknown,
): void => {
  if (pending.events.length >= DEFAULT_EVENT_COUNT) return;
  const redacted =
    source === undefined
      ? undefined
      : raw === undefined
        ? redactTransportText(source, secrets)
        : redactEventEvidence(raw, agent.redaction?.event_pointers ?? [], secrets);
  const excerpt = redacted === undefined ? undefined : createRawExcerpt(redacted);
  pending.events.push({
    classification,
    elapsed_ms: Math.max(0, Math.round(pending.duration())),
    ...(classification === 'connection_opened' ||
    classification === 'ping_sent' ||
    classification === 'pong_received'
      ? {}
      : { request_id: pending.requestId }),
    ...(messageBytes === undefined ? {} : { message_bytes: messageBytes }),
    ...(excerpt === undefined
      ? {}
      : excerpt.truncated && excerpt.sha256 !== undefined
        ? { excerpt: { text: excerpt.text, truncated: true, sha256: excerpt.sha256 } }
        : { excerpt: { text: excerpt.text, truncated: false } }),
  });
};

/** Attaches close details and records the connection boundary once. */
const recordClose = (
  agent: WebSocketAgentResource,
  pending: PendingInvocation,
  secrets: readonly string[],
  close: WebSocketClose,
): void => {
  pending.close = close;
  recordEvent(agent, pending, secrets, 'connection_closed');
};

const attemptEvidence = (
  agent: WebSocketAgentResource,
  pending: PendingInvocation,
  outcome: 'cancelled' | 'completed' | 'failed',
  classification?: WebSocketErrorClassification,
): WebSocketAttemptEvidence => {
  const base = {
    schema: WEBSOCKET_EVIDENCE_SCHEMA_ID,
    request_id: pending.requestId,
    lifecycle: agent.transport.lifecycle,
    connection_mode: agent.transport.connection_mode,
    acknowledgement: pending.acknowledged ? acknowledged : notAcknowledged,
    events: pending.events.slice(0, DEFAULT_EVENT_COUNT),
    ...(pending.close === undefined ? {} : { close: pending.close }),
  } as const;
  if (outcome === 'completed') return { ...base, outcome };
  return {
    ...base,
    outcome,
    error_classification:
      outcome === 'cancelled' ? 'cancelled' : (classification ?? 'connection_failed'),
  } as WebSocketAttemptEvidence;
};

/** Builds a failed attempt with bounded evidence and redacted raw text. */
const createFailureAttempt = (
  agent: WebSocketAgentResource,
  pending: PendingInvocation,
  secrets: readonly string[],
  error: AgentInvocationError,
  classification: WebSocketErrorClassification,
): InvocationAttempt => ({
  status: 'invocation_error',
  error,
  diagnostics: {},
  durationMs: pending.duration(),
  rawExcerpt: createRawExcerpt(
    redactTransportText(
      JSON.stringify(
        attemptEvidence(
          agent,
          pending,
          classification === 'cancelled' ? 'cancelled' : 'failed',
          classification,
        ),
      ),
      secrets,
    ),
  ),
  warnings: [],
});

/** Combines a terminal failure with all attempts already made by the request. */
const createFailureResult = (
  agent: WebSocketAgentResource,
  pending: PendingInvocation,
  secrets: readonly string[],
  error: AgentInvocationError,
  classification: WebSocketErrorClassification,
  priorAttempts = pending.attempts,
): InvocationResult => {
  const attempt = createFailureAttempt(agent, pending, secrets, error, classification);
  return { ...attempt, attempts: [...priorAttempts, attempt] };
};

type SuccessResult =
  { ok: true; result: InvocationResult } | { error: AgentInvocationError; ok: false };

/** Validates an extracted response and builds its completed invocation result. */
const createSuccessResult = (
  agent: WebSocketAgentResource,
  pending: PendingInvocation,
  secrets: readonly string[],
  response: AgentResponse,
): SuccessResult => {
  const report = parseAgentResponse(response);
  if (!report.ok) {
    return {
      ok: false,
      error: new AgentInvocationError(
        'invalid_envelope',
        'WebSocket extraction is not a valid agent response.',
      ),
    };
  }
  const attempt: InvocationAttempt = {
    status: 'ok',
    raw: response,
    report,
    diagnostics: {},
    durationMs: pending.duration(),
    rawExcerpt: createRawExcerpt(
      redactTransportText(JSON.stringify(attemptEvidence(agent, pending, 'completed')), secrets),
    ),
    warnings: report.warnings,
  };
  return { ok: true, result: { ...attempt, attempts: [...pending.attempts, attempt] } };
};

export {
  beginRetry,
  clearPendingTimers,
  countMessage,
  createFailureAttempt,
  createFailureResult,
  createPendingInvocation,
  createSuccessResult,
  recordClose,
  recordEvent,
  type PendingInvocation,
};
