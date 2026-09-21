import {
  AGENT_PROTOCOL,
  webSocketTransportSchema,
  type AgentRequest,
  type AgentResponse,
  type WebSocketErrorClassification,
} from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import type { InvocationAttempt, InvocationResult } from '../../types.js';
import {
  openWebSocket,
  type WebSocketClose,
  type WebSocketConnection,
} from './websocket-connection.js';
import {
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
} from './websocket-evidence.js';
import {
  DEFAULT_REQUEST_BYTES,
  classifiedError,
  correlationId,
  errorClassification,
  interpretServerMessage,
  materializeHeaders,
  materializeRequest,
  parseServerEnvelope,
  retryDelay,
  waitForRetry,
  type WebSocketAgentResource,
} from './websocket-protocol.js';

type WebSocketSessionOptions = {
  /** Runtime-resolved header values, including authored secret references. */
  headers?: Record<string, string>;
  secrets?: readonly string[];
  signal?: AbortSignal;
};

const DEFAULT_EVENT_BYTES = 1024 * 1024;
const MAX_TOMBSTONES = 1_024;

/** Runs one WebSocket lifecycle, either shared by the eval run or isolated per case. */
class WebSocketAgentSession {
  private readonly completed = new Set<string>();
  private readonly headers: Record<string, string>;
  private readonly ignored = new Set<string>();
  private readonly lifecycleController = new AbortController();
  private readonly pending = new Map<string, PendingInvocation>();
  private readonly secrets: readonly string[];
  private closePromise?: Promise<void>;
  private closed = false;
  private connection?: WebSocketConnection;
  private connectionPromise?: Promise<WebSocketConnection>;
  private connectionGeneration = 0;
  private pingTimer?: NodeJS.Timeout;
  private runTimer?: NodeJS.Timeout;
  private sequence = 0;
  private serialTail: Promise<void> = Promise.resolve();

  private constructor(
    readonly agent: WebSocketAgentResource,
    private readonly options: WebSocketSessionOptions,
  ) {
    this.headers = materializeHeaders(agent, options.headers ?? {});
    this.secrets = options.secrets ?? [];
    if (agent.timeouts?.run_ms !== undefined) {
      this.runTimer = setTimeout(() => {
        this.failRun(new AgentInvocationError('timeout', 'WebSocket run timed out.'));
        this.lifecycleController.abort();
      }, agent.timeouts.run_ms);
    }
    options.signal?.addEventListener(
      'abort',
      () => {
        this.failRun(new AgentInvocationError('cancelled', 'WebSocket run was cancelled.'));
        this.lifecycleController.abort();
      },
      { once: true },
    );
  }

  /** Validates the frozen transport surface before any remote connection can be opened. */
  static start(
    agent: WebSocketAgentResource,
    options: WebSocketSessionOptions = {},
  ): WebSocketAgentSession {
    const parsed = webSocketTransportSchema.safeParse(agent.transport);
    if (!parsed.success) {
      throw new AgentInvocationError(
        'invalid_envelope',
        'WebSocket transport uses an invalid or unsupported mode.',
      );
    }
    if (agent.transport.url.includes('{{')) {
      throw new AgentInvocationError(
        'invalid_envelope',
        'WebSocket runtime URLs must have a static authority and path.',
      );
    }
    return new WebSocketAgentSession(agent, options);
  }

  /** Invokes one case while honoring the authored serial or multiplexed run policy. */
  async invoke(request: AgentRequest, signal?: AbortSignal): Promise<InvocationResult> {
    if (this.agent.transport.lifecycle === 'per_case') return this.invokePerCase(request, signal);
    if (this.agent.transport.connection_mode === 'multiplexed')
      return this.invokeRunScoped(request, signal);
    let resolveResult!: (result: InvocationResult) => void;
    const result = new Promise<InvocationResult>((resolve) => {
      resolveResult = resolve;
    });
    const scheduled = this.serialTail.then(async () => {
      resolveResult(await this.invokeRunScoped(request, signal));
    });
    this.serialTail = scheduled.catch(() => undefined);
    return result;
  }

  private async invokePerCase(
    request: AgentRequest,
    signal?: AbortSignal,
  ): Promise<InvocationResult> {
    const attempts: InvocationAttempt[] = [];
    for (let retry = 0; ; retry += 1) {
      const requestId = correlationId(request, ++this.sequence);
      const result = await this.runPerCaseAttempt(request, requestId, signal);
      const acknowledgedAttempt = this.lastAttemptAcknowledged(result);
      if (
        result.status === 'ok' ||
        acknowledgedAttempt ||
        retry >= (this.agent.retry?.retries ?? 0) ||
        result.status !== 'invocation_error' ||
        !['network', 'timeout'].includes(result.error.code) ||
        result.error.code === 'cancelled'
      ) {
        return { ...result, attempts: [...attempts, ...result.attempts] };
      }
      attempts.push(...result.attempts);
      try {
        await waitForRetry(retryDelay(this.agent, retry), signal);
      } catch (error: unknown) {
        return createFailureResult(
          this.agent,
          createPendingInvocation(request, requestId, () => undefined, signal),
          this.secrets,
          error instanceof AgentInvocationError ? error : result.error,
          'cancelled',
          attempts,
        );
      }
    }
  }

  private async runPerCaseAttempt(
    request: AgentRequest,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<InvocationResult> {
    if (this.closed) {
      const pending = createPendingInvocation(request, requestId, () => undefined, signal);
      return createFailureResult(
        this.agent,
        pending,
        this.secrets,
        new AgentInvocationError('network', 'WebSocket session is closed.'),
        'connection_failed',
      );
    }
    let resolveResult!: (result: InvocationResult) => void;
    const result = new Promise<InvocationResult>((resolve) => {
      resolveResult = resolve;
    });
    const pending = createPendingInvocation(request, requestId, resolveResult, signal);
    let connection: WebSocketConnection | undefined;
    const attemptController = new AbortController();
    const signalCombined = AbortSignal.any([
      attemptController.signal,
      this.lifecycleController.signal,
      ...(signal === undefined ? [] : [signal]),
    ]);
    const lose = (error: AgentInvocationError): void => {
      if (!this.pending.has(requestId)) return;
      this.settleFailure(pending, error, errorClassification(error));
    };
    this.pending.set(requestId, pending);
    this.armPending(pending);
    try {
      connection = await this.openConnection(signalCombined, {
        onClose: (close) => {
          recordClose(this.agent, pending, this.secrets, close);
          if (this.pending.has(requestId)) {
            lose(
              classifiedError(
                'unexpected_close',
                'network',
                'WebSocket closed before a terminal response.',
              ),
            );
          }
        },
        onFailure: lose,
        onPong: () => recordEvent(this.agent, pending, this.secrets, 'pong_received'),
        onText: (text, bytes) => this.consumeMessage(text, bytes, new Set([requestId])),
      });
      // Closing a session can settle the invocation while an HTTP upgrade is still racing.
      if (this.closed || signalCombined.aborted || !this.pending.has(requestId)) {
        connection.destroy();
        return result;
      }
      pending.connection = connection;
      recordEvent(this.agent, pending, this.secrets, 'connection_opened');
      await this.send(pending, connection, signalCombined);
      const terminal = await result;
      const close = await connection.close(this.agent.transport.close_timeout_ms);
      recordClose(this.agent, pending, this.secrets, close);
      if (!close.clean && terminal.status === 'ok') {
        return createFailureResult(
          this.agent,
          pending,
          this.secrets,
          classifiedError('close_timeout', 'timeout', 'WebSocket close handshake timed out.'),
          'close_timeout',
          terminal.attempts.slice(0, -1),
        );
      }
      return terminal;
    } catch (error: unknown) {
      const normalized =
        error instanceof AgentInvocationError
          ? error
          : new AgentInvocationError('network', 'WebSocket connection failed.', { cause: error });
      if (this.pending.has(requestId))
        this.settleFailure(pending, normalized, errorClassification(normalized));
      return result;
    } finally {
      attemptController.abort();
      connection?.destroy();
      this.pending.delete(requestId);
      clearPendingTimers(pending);
    }
  }

  private invokeRunScoped(request: AgentRequest, signal?: AbortSignal): Promise<InvocationResult> {
    if (this.closed) {
      const pending = createPendingInvocation(
        request,
        correlationId(request, ++this.sequence),
        () => undefined,
        signal,
      );
      return Promise.resolve(
        createFailureResult(
          this.agent,
          pending,
          this.secrets,
          new AgentInvocationError('network', 'WebSocket session is closed.'),
          'connection_failed',
        ),
      );
    }
    let resolveResult!: (result: InvocationResult) => void;
    const result = new Promise<InvocationResult>((resolve) => {
      resolveResult = resolve;
    });
    const pending = createPendingInvocation(
      request,
      correlationId(request, ++this.sequence),
      resolveResult,
      signal,
    );
    this.pending.set(pending.requestId, pending);
    this.armPending(pending);
    void this.dispatchRunScoped(pending);
    return result;
  }

  private async dispatchRunScoped(pending: PendingInvocation): Promise<void> {
    try {
      const connection = await this.ensureConnection();
      if (!this.pending.has(pending.requestId)) return;
      await this.send(pending, connection);
    } catch (error: unknown) {
      if (!this.pending.has(pending.requestId)) return;
      const normalized =
        error instanceof AgentInvocationError
          ? error
          : new AgentInvocationError('network', 'WebSocket connection failed.', { cause: error });
      await this.retryOrSettle(pending, normalized, errorClassification(normalized));
    }
  }

  private ensureConnection(): Promise<WebSocketConnection> {
    if (this.connection !== undefined) return Promise.resolve(this.connection);
    if (this.connectionPromise !== undefined) return this.connectionPromise;
    const generation = ++this.connectionGeneration;
    const runSignal =
      this.options.signal === undefined
        ? this.lifecycleController.signal
        : AbortSignal.any([this.options.signal, this.lifecycleController.signal]);
    this.connectionPromise = this.openConnection(runSignal, {
      onClose: (close) => this.connectionLost(generation, close),
      onFailure: (error) => this.connectionFailed(generation, error),
      onPong: () => {
        for (const pending of this.pending.values()) {
          recordEvent(this.agent, pending, this.secrets, 'pong_received');
        }
      },
      onText: (text, bytes) => this.consumeMessage(text, bytes),
    }).then(
      (connection) => {
        this.connection = connection;
        this.connectionPromise = undefined;
        for (const pending of this.pending.values()) {
          recordEvent(this.agent, pending, this.secrets, 'connection_opened');
        }
        this.startPing(connection, generation);
        return connection;
      },
      (error: unknown) => {
        this.connectionPromise = undefined;
        throw error;
      },
    );
    return this.connectionPromise;
  }

  private openConnection(
    signal: AbortSignal,
    callbacks: Parameters<typeof openWebSocket>[0]['callbacks'],
  ): Promise<WebSocketConnection> {
    return openWebSocket({
      url: this.agent.transport.url,
      headers: this.headers,
      ...(this.agent.transport.subprotocol === undefined
        ? {}
        : { subprotocol: this.agent.transport.subprotocol }),
      openTimeoutMs: this.agent.transport.open_timeout_ms,
      maximumMessageBytes: this.agent.limits?.event_bytes ?? DEFAULT_EVENT_BYTES,
      maximumPendingWriteBytes: this.agent.limits?.request_bytes ?? DEFAULT_REQUEST_BYTES,
      secrets: this.secrets,
      signal,
      callerSignal: signal,
      callbacks,
    });
  }

  private async send(
    pending: PendingInvocation,
    connection: WebSocketConnection,
    signal = pending.signal,
  ): Promise<void> {
    const text = materializeRequest(this.agent, pending.request, pending.requestId);
    await connection.sendText(text, signal);
    if (!this.pending.has(pending.requestId)) return;
    recordEvent(this.agent, pending, this.secrets, 'request_sent', Buffer.byteLength(text));
    this.resetIdle(pending);
  }

  private consumeMessage(text: string, bytes: number, scope?: ReadonlySet<string>): void {
    const envelope = parseServerEnvelope(text, this.agent.transport.request_id_pointer);
    if ('error' in envelope) {
      this.failScope(envelope.error, scope, envelope.classification);
      return;
    }
    const { raw, requestId } = envelope;
    const pending = this.pending.get(requestId);
    if (pending === undefined || (scope !== undefined && !scope.has(requestId))) {
      if (this.ignored.has(requestId)) return;
      const duplicate = this.completed.has(requestId);
      this.failScope(
        new AgentInvocationError(
          'invalid_envelope',
          duplicate
            ? 'WebSocket server emitted a duplicate terminal message.'
            : 'WebSocket server emitted uncorrelated work.',
        ),
        scope,
        duplicate ? 'duplicate_terminal_message' : 'uncorrelated_server_work',
      );
      return;
    }
    this.resetIdle(pending);
    if (!countMessage(this.agent, pending, bytes)) {
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
    if (message.acknowledgement) {
      pending.acknowledged = true;
      recordEvent(this.agent, pending, this.secrets, 'acknowledgement_received', bytes, text, raw);
    }
    if (message.trace !== undefined) {
      pending.trace = message.trace;
      recordEvent(this.agent, pending, this.secrets, 'trace_received', bytes, text, raw);
    }
    if (message.failure !== undefined) {
      this.settleFailure(pending, message.failure.error, message.failure.classification);
      return;
    }
    if (message.terminal?.kind === 'error') {
      recordEvent(this.agent, pending, this.secrets, 'error_received', bytes, text, raw);
      this.settleSuccess(pending, {
        protocol: AGENT_PROTOCOL,
        error: message.terminal.value,
        ...(pending.trace === undefined ? {} : { trace: pending.trace }),
      } as AgentResponse);
      return;
    }
    if (message.terminal?.kind === 'result') {
      recordEvent(this.agent, pending, this.secrets, 'result_received', bytes, text, raw);
      this.settleSuccess(pending, {
        protocol: AGENT_PROTOCOL,
        output: message.terminal.value,
        ...(pending.trace === undefined ? {} : { trace: pending.trace }),
      } as AgentResponse);
    }
  }

  private armPending(pending: PendingInvocation): void {
    pending.attemptTimer = setTimeout(
      () =>
        void this.retryOrSettle(
          pending,
          classifiedError('attempt_timeout', 'timeout', 'WebSocket attempt timed out.'),
          'attempt_timeout',
        ),
      this.agent.transport.attempt_timeout_ms,
    );
    if (pending.signal !== undefined) {
      pending.callerAbort = () => {
        this.settleFailure(
          pending,
          classifiedError('cancelled', 'cancelled', 'WebSocket request was cancelled.'),
          'cancelled',
        );
        if (this.agent.transport.lifecycle === 'per_case') pending.connection?.destroy();
      };
      pending.signal.addEventListener('abort', pending.callerAbort, { once: true });
      if (pending.signal.aborted) pending.callerAbort();
    }
  }

  private resetIdle(pending: PendingInvocation): void {
    if (pending.idleTimer !== undefined) clearTimeout(pending.idleTimer);
    pending.idleTimer = setTimeout(
      () =>
        void this.retryOrSettle(
          pending,
          classifiedError('message_idle_timeout', 'timeout', 'WebSocket message became idle.'),
          'message_idle_timeout',
        ),
      this.agent.transport.message_idle_timeout_ms,
    );
  }

  private settleFailure(
    pending: PendingInvocation,
    error: AgentInvocationError,
    classification: WebSocketErrorClassification,
  ): void {
    if (!this.pending.has(pending.requestId)) return;
    this.pending.delete(pending.requestId);
    if (classification === 'cancelled' || error.code === 'timeout') {
      this.remember(this.ignored, pending.requestId);
    } else {
      this.remember(this.completed, pending.requestId);
    }
    clearPendingTimers(pending);
    pending.resolve(createFailureResult(this.agent, pending, this.secrets, error, classification));
  }

  private settleSuccess(pending: PendingInvocation, response: AgentResponse): void {
    const success = createSuccessResult(this.agent, pending, this.secrets, response);
    if (!success.ok) {
      this.settleFailure(
        pending,
        success.error,
        pending.trace === undefined ? 'result_extraction_failed' : 'trace_extraction_failed',
      );
      return;
    }
    this.pending.delete(pending.requestId);
    this.remember(this.completed, pending.requestId);
    clearPendingTimers(pending);
    pending.resolve(success.result);
  }

  private async retryOrSettle(
    pending: PendingInvocation,
    error: AgentInvocationError,
    classification: WebSocketErrorClassification,
  ): Promise<void> {
    if (!this.pending.has(pending.requestId)) return;
    const retryable =
      !pending.acknowledged &&
      pending.retriesUsed < (this.agent.retry?.retries ?? 0) &&
      error.code !== 'cancelled' &&
      ['network', 'timeout'].includes(error.code) &&
      ['connection_failed', 'handshake_failed', 'open_timeout', 'unexpected_close'].includes(
        classification,
      );
    if (!retryable || this.agent.transport.lifecycle === 'per_case') {
      this.settleFailure(pending, error, classification);
      return;
    }
    pending.attempts.push(
      createFailureAttempt(this.agent, pending, this.secrets, error, classification),
    );
    pending.retriesUsed += 1;
    beginRetry(pending);
    recordEvent(this.agent, pending, this.secrets, 'retry_scheduled');
    try {
      await waitForRetry(
        retryDelay(this.agent, pending.retriesUsed - 1),
        pending.signal ?? this.options.signal,
      );
      if (!this.pending.has(pending.requestId)) return;
      recordEvent(this.agent, pending, this.secrets, 'reconnect_started');
      this.armPending(pending);
      await this.dispatchRunScoped(pending);
    } catch (waitError: unknown) {
      this.settleFailure(
        pending,
        waitError instanceof AgentInvocationError ? waitError : error,
        'cancelled',
      );
    }
  }

  private lastAttemptAcknowledged(result: InvocationResult): boolean {
    const evidenceText = result.rawExcerpt?.text;
    return evidenceText?.includes('"state":"acknowledged"') === true;
  }

  private connectionFailed(generation: number, error: AgentInvocationError): void {
    if (generation !== this.connectionGeneration) return;
    this.connection?.destroy();
    this.connection = undefined;
    this.connectionPromise = undefined;
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    for (const pending of [...this.pending.values()]) {
      void this.retryOrSettle(pending, error, errorClassification(error));
    }
  }

  private connectionLost(generation: number, close: WebSocketClose): void {
    if (generation !== this.connectionGeneration || this.connection === undefined) return;
    this.connection = undefined;
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    const error = classifiedError(
      'unexpected_close',
      'network',
      'WebSocket disconnected before requests settled.',
    );
    for (const pending of [...this.pending.values()]) {
      recordClose(this.agent, pending, this.secrets, close);
      void this.retryOrSettle(pending, error, 'unexpected_close');
    }
  }

  private startPing(connection: WebSocketConnection, generation: number): void {
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (generation !== this.connectionGeneration || this.connection !== connection) return;
      if (!connection.ping()) return;
      for (const pending of this.pending.values()) {
        recordEvent(this.agent, pending, this.secrets, 'ping_sent');
      }
    }, this.agent.transport.ping_interval_ms);
  }

  private remember(target: Set<string>, requestId: string): void {
    target.add(requestId);
    if (target.size > MAX_TOMBSTONES) {
      const oldest = target.values().next().value;
      if (oldest !== undefined) target.delete(oldest);
    }
  }

  private failRun(error: AgentInvocationError, classification = errorClassification(error)): void {
    if (this.closed) return;
    this.closed = true;
    if (this.runTimer !== undefined) clearTimeout(this.runTimer);
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    for (const pending of [...this.pending.values()]) {
      this.settleFailure(pending, error, classification);
    }
    this.connection?.destroy();
    this.connection = undefined;
    this.lifecycleController.abort();
  }

  private failScope(
    error: AgentInvocationError,
    scope?: ReadonlySet<string>,
    classification = errorClassification(error),
  ): void {
    if (scope === undefined) {
      this.failRun(error, classification);
      return;
    }
    for (const requestId of scope) {
      const pending = this.pending.get(requestId);
      if (pending !== undefined) {
        this.settleFailure(pending, error, classification);
      }
    }
  }

  /** Ends the run-scoped lifecycle and guarantees bounded socket cleanup. */
  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.lifecycleController.abort();
    if (this.runTimer !== undefined) clearTimeout(this.runTimer);
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    for (const pending of [...this.pending.values()]) {
      this.settleFailure(
        pending,
        new AgentInvocationError('cancelled', 'WebSocket session closed.'),
        'cancelled',
      );
    }
    this.closePromise = (async () => {
      const connection = this.connection;
      this.connection = undefined;
      if (connection === undefined) return;
      const close = await connection.close(this.agent.transport.close_timeout_ms);
      if (!close.clean) {
        throw classifiedError('close_timeout', 'timeout', 'WebSocket close handshake timed out.');
      }
    })();
    return this.closePromise;
  }
}

const startWebSocketAgent = (
  agent: WebSocketAgentResource,
  options: WebSocketSessionOptions = {},
): Promise<WebSocketAgentSession> => Promise.resolve(WebSocketAgentSession.start(agent, options));

export {
  WebSocketAgentSession,
  startWebSocketAgent,
  type WebSocketAgentResource,
  type WebSocketSessionOptions,
};
