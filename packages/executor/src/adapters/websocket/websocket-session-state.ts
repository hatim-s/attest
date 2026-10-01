import {
  AGENT_PROTOCOL,
  type AgentRequest,
  type WebSocketErrorClassification,
} from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { DEFAULT_EVENT_BYTES, DEFAULT_REQUEST_BYTES } from '../../internal/agent-defaults.js';
import { correlationId } from '../../internal/correlation-id.js';
import type { InvocationResult } from '../../types.js';
import {
  openWebSocket,
  type WebSocketConnection,
  type WebSocketConnectionCallbacks,
} from './websocket-connection.js';
import {
  clearPendingTimers,
  createEvidenceRecorder,
  createPendingInvocation,
  type EvidenceRecorder,
  type PendingInvocation,
} from './websocket-evidence.js';
import {
  errorClassification,
  interpretServerMessage,
  parseServerEnvelope,
  type WebSocketAgentResource,
} from './websocket-protocol.js';
import { materializeHeaders, materializeRequest } from './websocket-request.js';

type WebSocketSessionOptions = {
  /** Runtime-resolved header values, including authored secret references. */
  headers?: Record<string, string>;
  secrets?: readonly string[];
  signal?: AbortSignal;
};

type SessionHooks = {
  /** A request's attempt or idle deadline passed; the session decides whether to retry. */
  onRequestTimeout: (
    pending: PendingInvocation,
    error: AgentInvocationError,
    classification: WebSocketErrorClassification,
  ) => void;
  /** The run ended early; the session releases its connections and timers. */
  onRunEnd: () => void;
};

const MAX_TOMBSTONES = 1_024;

/** Remembers a settled request id, evicting the oldest once the bound is reached. */
const remember = (target: Set<string>, requestId: string): void => {
  target.add(requestId);
  if (target.size <= MAX_TOMBSTONES) return;
  const oldest = target.values().next().value;
  if (oldest !== undefined) target.delete(oldest);
};

/**
 * Request bookkeeping shared by per-case and run-scoped WebSocket sessions: correlation,
 * deadlines, message interpretation, settlement, and the run deadline.
 */
class WebSocketSessionState {
  readonly pending = new Map<string, PendingInvocation>();
  readonly evidence: EvidenceRecorder;
  /** Aborts every connection and write when the run ends. */
  readonly lifecycle = new AbortController();
  closed = false;
  private readonly completed = new Set<string>();
  private readonly ignored = new Set<string>();
  private readonly headers: Record<string, string>;
  private readonly secrets: readonly string[];
  private readonly runTimer?: NodeJS.Timeout;
  private sequence = 0;

  constructor(
    readonly agent: WebSocketAgentResource,
    readonly options: WebSocketSessionOptions,
    private readonly hooks: SessionHooks,
  ) {
    this.headers = materializeHeaders(agent, options.headers ?? {});
    this.secrets = options.secrets ?? [];
    this.evidence = createEvidenceRecorder(agent, this.secrets);
    const runMs = agent.timeouts?.run_ms;
    if (runMs !== undefined) {
      this.runTimer = setTimeout(
        () => this.failRun(new AgentInvocationError('timeout', 'WebSocket run timed out.')),
        runMs,
      );
    }
    options.signal?.addEventListener(
      'abort',
      () => this.failRun(new AgentInvocationError('cancelled', 'WebSocket run was cancelled.')),
      { once: true },
    );
  }

  /** Creates the state for a new request with a fresh bounded correlation id. */
  createPending(
    request: AgentRequest,
    signal: AbortSignal | undefined,
    resolve: (result: InvocationResult) => void = () => undefined,
  ): PendingInvocation {
    return createPendingInvocation(
      request,
      correlationId('ws', request, ++this.sequence),
      resolve,
      signal,
    );
  }

  /** The result for a request that arrives after the session closed. */
  closedResult(pending: PendingInvocation): InvocationResult {
    return this.evidence.failureResult(
      pending,
      new AgentInvocationError('network', 'WebSocket session is closed.'),
      'connection_failed',
      [],
    );
  }

  openConnection(
    signal: AbortSignal,
    callbacks: WebSocketConnectionCallbacks,
  ): Promise<WebSocketConnection> {
    const { transport } = this.agent;
    return openWebSocket({
      url: transport.url,
      headers: this.headers,
      ...(transport.subprotocol === undefined ? {} : { subprotocol: transport.subprotocol }),
      openTimeoutMs: transport.open_timeout_ms,
      maximumMessageBytes: this.agent.limits?.event_bytes ?? DEFAULT_EVENT_BYTES,
      maximumPendingWriteBytes: this.agent.limits?.request_bytes ?? DEFAULT_REQUEST_BYTES,
      secrets: this.secrets,
      signal,
      callerSignal: signal,
      callbacks,
    });
  }

  async send(
    pending: PendingInvocation,
    connection: WebSocketConnection,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const text = materializeRequest(this.agent, pending.request, pending.requestId);
    await connection.sendText(text, signal);
    if (!this.pending.has(pending.requestId)) return;
    this.evidence.record(pending, {
      classification: 'request_sent',
      bytes: Buffer.byteLength(text),
    });
    this.resetIdle(pending);
  }

  /** Tracks a request and starts its attempt deadline and caller cancellation. */
  arm(pending: PendingInvocation): void {
    this.pending.set(pending.requestId, pending);
    pending.attemptTimer = setTimeout(
      () =>
        this.hooks.onRequestTimeout(
          pending,
          new AgentInvocationError('timeout', 'WebSocket attempt timed out.', {
            classification: 'attempt_timeout',
          }),
          'attempt_timeout',
        ),
      this.agent.transport.attempt_timeout_ms,
    );
    const { signal } = pending;
    if (signal === undefined) return;
    pending.callerAbort = () => {
      this.settleFailure(
        pending,
        new AgentInvocationError('cancelled', 'WebSocket request was cancelled.', {
          classification: 'cancelled',
        }),
        'cancelled',
      );
      // Only a per-case request owns its connection; run-scoped requests share one.
      pending.connection?.destroy();
    };
    signal.addEventListener('abort', pending.callerAbort, { once: true });
    if (signal.aborted) pending.callerAbort();
  }

  /**
   * Interprets one server message. `scope` limits which requests the connection may answer;
   * a protocol violation fails that scope, or the whole run when the connection is shared.
   */
  consumeMessage(text: string, bytes: number, scope?: ReadonlySet<string>): void {
    const envelope = parseServerEnvelope(text, this.agent.transport.request_id_pointer);
    if ('error' in envelope) {
      this.failScope(envelope.error, envelope.classification, scope);
      return;
    }
    const { raw, requestId } = envelope;
    const pending = this.pending.get(requestId);
    if (pending === undefined || (scope !== undefined && !scope.has(requestId))) {
      this.rejectUnknown(requestId, scope);
      return;
    }
    this.resetIdle(pending);
    if (!this.evidence.countMessage(pending, bytes)) {
      this.settleFailure(
        pending,
        new AgentInvocationError(
          'output_cap_exceeded',
          'WebSocket evidence exceeds its configured cap.',
        ),
        'connection_failed',
      );
      return;
    }
    const message = interpretServerMessage(raw, this.agent, pending.acknowledged);
    const event = { bytes, source: text, raw };
    if (message.acknowledgement) {
      pending.acknowledged = true;
      this.evidence.record(pending, { classification: 'acknowledgement_received', ...event });
    }
    if (message.trace !== undefined) {
      pending.trace = message.trace;
      this.evidence.record(pending, { classification: 'trace_received', ...event });
    }
    if (message.failure !== undefined) {
      this.settleFailure(pending, message.failure.error, message.failure.classification);
      return;
    }
    if (message.terminal === undefined) return;
    const trace = pending.trace === undefined ? {} : { trace: pending.trace };
    if (message.terminal.kind === 'error') {
      this.evidence.record(pending, { classification: 'error_received', ...event });
      this.settleSuccess(pending, {
        protocol: AGENT_PROTOCOL,
        error: message.terminal.value,
        ...trace,
      });
      return;
    }
    this.evidence.record(pending, { classification: 'result_received', ...event });
    this.settleSuccess(pending, {
      protocol: AGENT_PROTOCOL,
      output: message.terminal.value,
      ...trace,
    });
  }

  settleFailure(
    pending: PendingInvocation,
    error: AgentInvocationError,
    classification: WebSocketErrorClassification,
  ): void {
    if (!this.pending.has(pending.requestId)) return;
    this.pending.delete(pending.requestId);
    // Late messages for a request attest stopped are expected; after a failure they are not.
    const stoppedByAttest = classification === 'cancelled' || error.code === 'timeout';
    remember(stoppedByAttest ? this.ignored : this.completed, pending.requestId);
    clearPendingTimers(pending);
    pending.resolve(this.evidence.failureResult(pending, error, classification, pending.attempts));
  }

  /** Ends the run: every outstanding request fails and the session stops admitting work. */
  failRun(error: AgentInvocationError, classification = errorClassification(error)): void {
    if (this.closed) return;
    this.closed = true;
    this.settleAll(error, classification);
    this.hooks.onRunEnd();
    this.lifecycle.abort();
  }

  /** Closes the session on its owner's request; connections are closed gracefully by the owner. */
  beginClose(): void {
    this.closed = true;
    this.lifecycle.abort();
    this.settleAll(new AgentInvocationError('cancelled', 'WebSocket session closed.'), 'cancelled');
  }

  private settleAll(
    error: AgentInvocationError,
    classification: WebSocketErrorClassification,
  ): void {
    clearTimeout(this.runTimer);
    for (const pending of [...this.pending.values()]) {
      this.settleFailure(pending, error, classification);
    }
  }

  private settleSuccess(pending: PendingInvocation, response: Record<string, unknown>): void {
    const success = this.evidence.successResult(pending, response);
    if (!success.ok) {
      this.settleFailure(
        pending,
        success.error,
        pending.trace === undefined ? 'result_extraction_failed' : 'trace_extraction_failed',
      );
      return;
    }
    this.pending.delete(pending.requestId);
    remember(this.completed, pending.requestId);
    clearPendingTimers(pending);
    pending.resolve(success.result);
  }

  private resetIdle(pending: PendingInvocation): void {
    clearTimeout(pending.idleTimer);
    pending.idleTimer = setTimeout(
      () =>
        this.hooks.onRequestTimeout(
          pending,
          new AgentInvocationError('timeout', 'WebSocket message became idle.', {
            classification: 'message_idle_timeout',
          }),
          'message_idle_timeout',
        ),
      this.agent.transport.message_idle_timeout_ms,
    );
  }

  /** Fails work the server sent for a request that is not outstanding on this connection. */
  private rejectUnknown(requestId: string, scope: ReadonlySet<string> | undefined): void {
    if (this.ignored.has(requestId)) return;
    if (this.completed.has(requestId)) {
      this.failScope(
        new AgentInvocationError(
          'invalid_envelope',
          'WebSocket server emitted a duplicate terminal message.',
        ),
        'duplicate_terminal_message',
        scope,
      );
      return;
    }
    this.failScope(
      new AgentInvocationError('invalid_envelope', 'WebSocket server emitted uncorrelated work.'),
      'uncorrelated_server_work',
      scope,
    );
  }

  private failScope(
    error: AgentInvocationError,
    classification: WebSocketErrorClassification,
    scope: ReadonlySet<string> | undefined,
  ): void {
    if (scope === undefined) {
      this.failRun(error, classification);
      return;
    }
    for (const requestId of scope) {
      const pending = this.pending.get(requestId);
      if (pending !== undefined) this.settleFailure(pending, error, classification);
    }
  }
}

export { WebSocketSessionState, type WebSocketSessionOptions };
