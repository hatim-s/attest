import {
  parseAgentResponse,
  WEBSOCKET_EVIDENCE_SCHEMA_ID,
  type AgentRequest,
  type JsonValue,
  type RawExcerpt,
  type WebSocketAttemptEvidence,
  type WebSocketErrorClassification,
} from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import {
  DEFAULT_EVENT_COUNT,
  DEFAULT_TOTAL_EVIDENCE_BYTES,
} from '../../internal/agent-defaults.js';
import { startTimer } from '../../internal/elapsed.js';
import { createFailedAttempt } from '../../internal/failed-attempt.js';
import { createRawExcerpt } from '../../internal/raw-excerpt.js';
import type { InvocationAttempt, InvocationResult } from '../../types.js';
import { redactEventEvidence, redactTransportText } from '../http/redaction.js';
import type { WebSocketClose, WebSocketConnection } from './websocket-connection.js';
import type { WebSocketAgentResource } from './websocket-protocol.js';

/** Evidence keeps at most this many lifecycle events per attempt, independent of the message cap. */
const EVIDENCE_EVENT_CAP = 1_024;

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

type EvidenceBase = Omit<Extract<WebSocketAttemptEvidence, { outcome: 'completed' }>, 'outcome'>;

/** One lifecycle event; message events also carry their size and the text they excerpt. */
type RecordedEvent = {
  classification: EvidenceEvent['classification'];
  bytes?: number;
  /** Raw message text, redacted before it becomes an excerpt. */
  source?: string;
  /** Parsed message, so authored event pointers can be redacted field by field. */
  raw?: unknown;
};

/** Connection-level events describe the socket, not one request, so they omit the request id. */
const CONNECTION_EVENTS = new Set<EvidenceEvent['classification']>([
  'connection_opened',
  'ping_sent',
  'pong_received',
]);

/** Session-scoped evidence writer that applies one agent's caps and redaction to every request. */
type EvidenceRecorder = {
  /** Counts a message against the caps; false means the request must fail before retaining it. */
  countMessage: (pending: PendingInvocation, bytes: number) => boolean;
  record: (pending: PendingInvocation, event: RecordedEvent) => void;
  recordClose: (pending: PendingInvocation, close: WebSocketClose) => void;
  failureAttempt: (
    pending: PendingInvocation,
    error: AgentInvocationError,
    classification: WebSocketErrorClassification,
  ) => InvocationAttempt;
  /** Ends a request with a failure appended to `priorAttempts`. */
  failureResult: (
    pending: PendingInvocation,
    error: AgentInvocationError,
    classification: WebSocketErrorClassification,
    priorAttempts: readonly InvocationAttempt[],
  ) => InvocationResult;
  /** Validates a candidate envelope extracted from a terminal message. */
  successResult: (pending: PendingInvocation, response: Record<string, unknown>) => SuccessResult;
};

type SuccessResult =
  { ok: true; result: InvocationResult } | { error: AgentInvocationError; ok: false };

/** Creates the evidence writer for one WebSocket session. */
const createEvidenceRecorder = (
  agent: WebSocketAgentResource,
  secrets: readonly string[],
): EvidenceRecorder => {
  const redactSource = (source: string, raw: unknown): string => {
    if (raw === undefined) return redactTransportText(source, secrets);
    return redactEventEvidence(raw, agent.redaction?.event_pointers ?? [], secrets);
  };

  const excerptOf = (source: string | undefined, raw: unknown): EvidenceEvent['excerpt'] => {
    if (source === undefined) return undefined;
    const excerpt = createRawExcerpt(redactSource(source, raw));
    if (excerpt.truncated && excerpt.sha256 !== undefined) {
      return { text: excerpt.text, truncated: true, sha256: excerpt.sha256 };
    }
    return { text: excerpt.text, truncated: false };
  };

  const record = (pending: PendingInvocation, event: RecordedEvent): void => {
    if (pending.events.length >= EVIDENCE_EVENT_CAP) return;
    const excerpt = excerptOf(event.source, event.raw);
    pending.events.push({
      classification: event.classification,
      elapsed_ms: Math.max(0, Math.round(pending.duration())),
      ...(CONNECTION_EVENTS.has(event.classification) ? {} : { request_id: pending.requestId }),
      ...(event.bytes === undefined ? {} : { message_bytes: event.bytes }),
      ...(excerpt === undefined ? {} : { excerpt }),
    });
  };

  const evidenceBase = (pending: PendingInvocation): EvidenceBase => ({
    schema: WEBSOCKET_EVIDENCE_SCHEMA_ID,
    request_id: pending.requestId,
    lifecycle: agent.transport.lifecycle,
    connection_mode: agent.transport.connection_mode,
    acknowledgement: pending.acknowledged ? acknowledged : notAcknowledged,
    events: pending.events.slice(0, EVIDENCE_EVENT_CAP),
    ...(pending.close === undefined ? {} : { close: pending.close }),
  });

  const failureEvidence = (
    pending: PendingInvocation,
    classification: WebSocketErrorClassification,
  ): WebSocketAttemptEvidence => {
    if (classification === 'cancelled') {
      return { ...evidenceBase(pending), outcome: 'cancelled', error_classification: 'cancelled' };
    }
    return { ...evidenceBase(pending), outcome: 'failed', error_classification: classification };
  };

  const evidenceExcerpt = (evidence: WebSocketAttemptEvidence): RawExcerpt =>
    createRawExcerpt(redactTransportText(JSON.stringify(evidence), secrets));

  const failureAttempt: EvidenceRecorder['failureAttempt'] = (pending, error, classification) =>
    createFailedAttempt(error, {
      durationMs: pending.duration(),
      rawExcerpt: evidenceExcerpt(failureEvidence(pending, classification)),
    });

  return {
    countMessage: (pending, bytes) => {
      pending.messageCount += 1;
      pending.totalEvidenceBytes += bytes;
      return (
        pending.messageCount <= (agent.limits?.event_count ?? DEFAULT_EVENT_COUNT) &&
        pending.totalEvidenceBytes <=
          (agent.limits?.total_evidence_bytes ?? DEFAULT_TOTAL_EVIDENCE_BYTES)
      );
    },
    record,
    recordClose: (pending, close) => {
      pending.close = close;
      record(pending, { classification: 'connection_closed' });
    },
    failureAttempt,
    failureResult: (pending, error, classification, priorAttempts) => {
      const attempt = failureAttempt(pending, error, classification);
      return { ...attempt, attempts: [...priorAttempts, attempt] };
    },
    successResult: (pending, response) => {
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
        rawExcerpt: evidenceExcerpt({ ...evidenceBase(pending), outcome: 'completed' }),
        warnings: report.warnings,
      };
      return { ok: true, result: { ...attempt, attempts: [...pending.attempts, attempt] } };
    },
  };
};

export {
  beginRetry,
  clearPendingTimers,
  createEvidenceRecorder,
  createPendingInvocation,
  type EvidenceRecorder,
  type PendingInvocation,
};
