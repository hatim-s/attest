import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  AGENT_PROTOCOL,
  WEBSOCKET_EVIDENCE_SCHEMA_VERSION,
  WEBSOCKET_REQUEST_PROTOCOL,
  parseAgentResponse,
  webSocketTransportSchema,
  type AgentRequest,
  type AgentResource,
  type AgentResponse,
  type JsonValue,
  type SecretReference,
  type WebSocketAttemptEvidence,
  type WebSocketErrorClassification,
} from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { startTimer } from '../../internal/elapsed.js';
import { createRawExcerpt } from '../../internal/raw-excerpt.js';
import type { InvocationAttempt, InvocationResult } from '../../types.js';
import { readJsonPointer } from '../http/json-pointer.js';
import { redactEventEvidence, redactTransportText } from '../http/redaction.js';
import {
  openWebSocket,
  type WebSocketClose,
  type WebSocketConnection,
} from './websocket-connection.js';

type WebSocketAgentResource = AgentResource & {
  transport: Extract<AgentResource['transport'], { kind: 'websocket' }>;
};

type WebSocketSessionOptions = {
  /** Runtime-resolved header values, including authored secret references. */
  headers?: Record<string, string>;
  secrets?: readonly string[];
  signal?: AbortSignal;
};

type EvidenceEvent = WebSocketAttemptEvidence['events'][number];
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
  trace?: unknown;
};

type ClassifiedError = AgentInvocationError & {
  webSocketClassification?: WebSocketErrorClassification;
};

const DEFAULT_EVENT_BYTES = 1024 * 1024;
const DEFAULT_EVENT_COUNT = 1_024;
const DEFAULT_REQUEST_BYTES = 10 * 1024 * 1024;
const DEFAULT_TOTAL_EVIDENCE_BYTES = 10 * 1024 * 1024;
const MAX_TOMBSTONES = 1_024;
const FORBIDDEN_HANDSHAKE_HEADERS = new Set([
  'connection',
  'cookie',
  'host',
  'proxy-authorization',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'upgrade',
]);

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

/** Produces a contract-bounded correlation id without retaining authored case ids. */
const correlationId = (request: AgentRequest, sequence: number): string =>
  `ws-${sequence.toString(36)}-${createHash('sha256')
    .update(request.run_id)
    .update('\0')
    .update(request.case_id)
    .digest('hex')
    .slice(0, 32)}`;

const isSecretReference = (value: string | SecretReference): value is SecretReference =>
  typeof value !== 'string';

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === 'object' && Object.values(value as Record<string, unknown>).every(isJsonValue)
  );
};

const remoteError = (value: unknown): { code?: string; message: string } => {
  if (typeof value === 'string') return { message: value };
  if (value !== null && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.message === 'string') {
      return {
        message: candidate.message,
        ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
      };
    }
  }
  return { message: 'The WebSocket agent reported an error.' };
};

/** Maps internal transport failures onto the stable WebSocket evidence vocabulary. */
const errorClassification = (error: ClassifiedError): WebSocketErrorClassification => {
  if (error.webSocketClassification !== undefined) return error.webSocketClassification;
  if (error.code === 'cancelled') return 'cancelled';
  if (error.code === 'timeout') return 'attempt_timeout';
  if (error.code === 'invalid_envelope') return 'invalid_json';
  return 'connection_failed';
};

/** Materializes environment-backed headers while protecting the RFC 6455 handshake fields. */
const materializeHeaders = (
  agent: WebSocketAgentResource,
  resolvedHeaders: Record<string, string>,
): Record<string, string> => {
  const authored = agent.transport.headers ?? {};
  const resolvedByName = new Map(
    Object.entries(resolvedHeaders).map(([name, value]) => [
      name.toLowerCase(),
      [name, value] as const,
    ]),
  );
  const materialized = new Map<string, [string, string]>();
  for (const [name, value] of Object.entries(authored)) {
    const normalized = name.toLowerCase();
    if (FORBIDDEN_HANDSHAKE_HEADERS.has(normalized)) {
      throw new AgentInvocationError(
        'invalid_envelope',
        `WebSocket header ${name} is controlled by the runtime or unsupported.`,
      );
    }
    if (normalized === 'authorization' && !isSecretReference(value)) {
      throw new AgentInvocationError(
        'invalid_envelope',
        'Literal WebSocket authorization is unsupported.',
      );
    }
    const resolved = resolvedByName.get(normalized);
    if (isSecretReference(value) && resolved === undefined) {
      throw new AgentInvocationError(
        'invalid_envelope',
        `WebSocket secret header ${name} was not resolved at runtime.`,
      );
    }
    materialized.set(normalized, [name, resolved?.[1] ?? (value as string)]);
  }
  for (const [normalized, [name, value]] of resolvedByName) {
    if (FORBIDDEN_HANDSHAKE_HEADERS.has(normalized)) {
      throw new AgentInvocationError(
        'invalid_envelope',
        `WebSocket header ${name} is controlled by the runtime or unsupported.`,
      );
    }
    materialized.set(normalized, [name, value]);
  }
  return Object.fromEntries(materialized.values());
};

/** Renders the one frozen correlation slot and attaches the normalized invocation request. */
const materializeRequest = (
  agent: WebSocketAgentResource,
  request: AgentRequest,
  requestId: string,
): string => {
  const replace = (value: JsonValue): JsonValue => {
    if (value === '{{request_id}}') return requestId;
    if (Array.isArray(value)) return value.map(replace);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    }
    return value;
  };
  const rendered = replace(agent.transport.request_template);
  const frame = {
    ...(rendered as Record<string, JsonValue>),
    protocol: WEBSOCKET_REQUEST_PROTOCOL,
    request_id: requestId,
    request,
  };
  const text = JSON.stringify(frame);
  const cap = agent.limits?.request_bytes ?? DEFAULT_REQUEST_BYTES;
  if (Buffer.byteLength(text) > cap) {
    throw new AgentInvocationError(
      'output_cap_exceeded',
      `WebSocket request exceeds the ${cap}-byte request cap.`,
    );
  }
  return text;
};

const retryDelay = (agent: WebSocketAgentResource, retryIndex: number): number => {
  const backoff = agent.retry?.backoff;
  if (backoff === undefined || backoff.kind === 'none') return 0;
  if (backoff.kind === 'fixed') return backoff.delay_ms;
  const bounded = Math.min(backoff.initial_delay_ms * 2 ** retryIndex, backoff.maximum_delay_ms);
  const jitter = createHash('sha256')
    .update(`${String(backoff.jitter_seed)}:${String(retryIndex)}`)
    .digest()
    .readUInt32BE(0);
  return Math.floor((bounded * (75 + (jitter % 51))) / 100);
};

const wait = async (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted === true)
    throw new AgentInvocationError('cancelled', 'WebSocket retry was cancelled.');
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new AgentInvocationError('cancelled', 'WebSocket retry was cancelled.'));
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
};

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
        await wait(retryDelay(this.agent, retry), signal);
      } catch (error: unknown) {
        return this.failureResult(
          this.newPending(request, requestId, () => undefined, signal),
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
      const pending = this.newPending(request, requestId, () => undefined, signal);
      return this.failureResult(
        pending,
        new AgentInvocationError('network', 'WebSocket session is closed.'),
        'connection_failed',
      );
    }
    let resolveResult!: (result: InvocationResult) => void;
    const result = new Promise<InvocationResult>((resolve) => {
      resolveResult = resolve;
    });
    const pending = this.newPending(request, requestId, resolveResult, signal);
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
          this.recordClose(pending, close);
          if (this.pending.has(requestId)) {
            lose(
              Object.assign(
                new AgentInvocationError('network', 'WebSocket closed before a terminal response.'),
                { webSocketClassification: 'unexpected_close' as const },
              ),
            );
          }
        },
        onFailure: lose,
        onPong: () => this.record(pending, 'pong_received'),
        onText: (text, bytes) => this.consumeMessage(text, bytes, new Set([requestId])),
      });
      // Closing a session can settle the invocation while an HTTP upgrade is still racing.
      if (this.closed || signalCombined.aborted || !this.pending.has(requestId)) {
        connection.destroy();
        return result;
      }
      pending.connection = connection;
      this.record(pending, 'connection_opened');
      await this.send(pending, connection, signalCombined);
      const terminal = await result;
      const close = await connection.close(this.agent.transport.close_timeout_ms);
      this.recordClose(pending, close);
      if (!close.clean && terminal.status === 'ok') {
        return this.failureResult(
          pending,
          Object.assign(
            new AgentInvocationError('timeout', 'WebSocket close handshake timed out.'),
            {
              webSocketClassification: 'close_timeout' as const,
            },
          ),
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
      this.clearPending(pending);
    }
  }

  private invokeRunScoped(request: AgentRequest, signal?: AbortSignal): Promise<InvocationResult> {
    if (this.closed) {
      const pending = this.newPending(
        request,
        correlationId(request, ++this.sequence),
        () => undefined,
        signal,
      );
      return Promise.resolve(
        this.failureResult(
          pending,
          new AgentInvocationError('network', 'WebSocket session is closed.'),
          'connection_failed',
        ),
      );
    }
    let resolveResult!: (result: InvocationResult) => void;
    const result = new Promise<InvocationResult>((resolve) => {
      resolveResult = resolve;
    });
    const pending = this.newPending(
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
        for (const pending of this.pending.values()) this.record(pending, 'pong_received');
      },
      onText: (text, bytes) => this.consumeMessage(text, bytes),
    }).then(
      (connection) => {
        this.connection = connection;
        this.connectionPromise = undefined;
        for (const pending of this.pending.values()) this.record(pending, 'connection_opened');
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
    this.record(pending, 'request_sent', Buffer.byteLength(text));
    this.resetIdle(pending);
  }

  private consumeMessage(text: string, bytes: number, scope?: ReadonlySet<string>): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (error: unknown) {
      this.failScope(
        Object.assign(
          new AgentInvocationError('invalid_envelope', 'WebSocket message is not valid JSON.', {
            cause: error,
          }),
          { webSocketClassification: 'invalid_json' as const },
        ),
        scope,
      );
      return;
    }
    const requestId = readJsonPointer(raw, this.agent.transport.request_id_pointer);
    if (typeof requestId !== 'string') {
      this.failScope(
        Object.assign(
          new AgentInvocationError(
            'invalid_envelope',
            'WebSocket server work is missing a bounded correlation id.',
          ),
          { webSocketClassification: 'uncorrelated_server_work' as const },
        ),
        scope,
      );
      return;
    }
    const pending = this.pending.get(requestId);
    if (pending === undefined || (scope !== undefined && !scope.has(requestId))) {
      if (this.ignored.has(requestId)) return;
      const duplicate = this.completed.has(requestId);
      this.failScope(
        Object.assign(
          new AgentInvocationError(
            'invalid_envelope',
            duplicate
              ? 'WebSocket server emitted a duplicate terminal message.'
              : 'WebSocket server emitted uncorrelated work.',
          ),
          {
            webSocketClassification: duplicate
              ? ('duplicate_terminal_message' as const)
              : ('uncorrelated_server_work' as const),
          },
        ),
        scope,
      );
      return;
    }
    this.resetIdle(pending);
    const eventCap = this.agent.limits?.event_count ?? DEFAULT_EVENT_COUNT;
    pending.messageCount += 1;
    pending.totalEvidenceBytes += bytes;
    if (
      pending.messageCount > eventCap ||
      pending.totalEvidenceBytes >
        (this.agent.limits?.total_evidence_bytes ?? DEFAULT_TOTAL_EVIDENCE_BYTES)
    ) {
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
    const acknowledgementValue = readJsonPointer(raw, this.agent.transport.acknowledgement_pointer);
    const result = readJsonPointer(raw, this.agent.transport.result_pointer);
    const extractedError = readJsonPointer(raw, this.agent.transport.error_pointer);
    const trace =
      this.agent.transport.trace_pointer === undefined
        ? undefined
        : readJsonPointer(raw, this.agent.transport.trace_pointer);
    const isAcknowledgement = this.agent.transport.acknowledgement_values.some((value) =>
      isDeepStrictEqual(value, acknowledgementValue),
    );
    if (isAcknowledgement) {
      pending.acknowledged = true;
      this.record(pending, 'acknowledgement_received', bytes, text, raw);
    }
    if (trace !== undefined) {
      if (!isJsonValue(trace)) {
        this.settleFailure(
          pending,
          new AgentInvocationError('invalid_envelope', 'WebSocket trace extraction failed.'),
          'trace_extraction_failed',
        );
        return;
      }
      pending.trace = trace;
      this.record(pending, 'trace_received', bytes, text, raw);
    }
    const hasResult = result !== undefined;
    const hasError = extractedError !== undefined && extractedError !== null;
    if (hasResult && hasError) {
      this.settleFailure(
        pending,
        new AgentInvocationError(
          'invalid_envelope',
          'WebSocket message contains both result and error values.',
        ),
        'result_extraction_failed',
      );
      return;
    }
    if ((hasResult || hasError) && !pending.acknowledged) {
      this.settleFailure(
        pending,
        new AgentInvocationError(
          'invalid_envelope',
          'WebSocket terminal message arrived before acknowledgement.',
        ),
        'acknowledgement_extraction_failed',
      );
      return;
    }
    if (hasError) {
      this.record(pending, 'error_received', bytes, text, raw);
      this.settleSuccess(pending, {
        protocol: AGENT_PROTOCOL,
        error: remoteError(extractedError),
        ...(pending.trace === undefined ? {} : { trace: pending.trace }),
      } as AgentResponse);
      return;
    }
    if (hasResult) {
      if (!isJsonValue(result)) {
        this.settleFailure(
          pending,
          new AgentInvocationError('invalid_envelope', 'WebSocket result extraction failed.'),
          'result_extraction_failed',
        );
        return;
      }
      this.record(pending, 'result_received', bytes, text, raw);
      this.settleSuccess(pending, {
        protocol: AGENT_PROTOCOL,
        output: result,
        ...(pending.trace === undefined ? {} : { trace: pending.trace }),
      } as AgentResponse);
      return;
    }
    if (!isAcknowledgement && trace === undefined) {
      this.settleFailure(
        pending,
        new AgentInvocationError(
          'invalid_envelope',
          'WebSocket acknowledgement extraction failed.',
        ),
        'acknowledgement_extraction_failed',
      );
    }
  }

  private newPending(
    request: AgentRequest,
    requestId: string,
    resolve: (result: InvocationResult) => void,
    signal?: AbortSignal,
  ): PendingInvocation {
    return {
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
    };
  }

  private armPending(pending: PendingInvocation): void {
    pending.attemptTimer = setTimeout(
      () =>
        void this.retryOrSettle(
          pending,
          Object.assign(new AgentInvocationError('timeout', 'WebSocket attempt timed out.'), {
            webSocketClassification: 'attempt_timeout' as const,
          }),
          'attempt_timeout',
        ),
      this.agent.transport.attempt_timeout_ms,
    );
    if (pending.signal !== undefined) {
      pending.callerAbort = () => {
        this.settleFailure(
          pending,
          Object.assign(new AgentInvocationError('cancelled', 'WebSocket request was cancelled.'), {
            webSocketClassification: 'cancelled' as const,
          }),
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
          Object.assign(new AgentInvocationError('timeout', 'WebSocket message became idle.'), {
            webSocketClassification: 'message_idle_timeout' as const,
          }),
          'message_idle_timeout',
        ),
      this.agent.transport.message_idle_timeout_ms,
    );
  }

  private clearPending(pending: PendingInvocation): void {
    if (pending.attemptTimer !== undefined) clearTimeout(pending.attemptTimer);
    if (pending.idleTimer !== undefined) clearTimeout(pending.idleTimer);
    if (pending.callerAbort !== undefined)
      pending.signal?.removeEventListener('abort', pending.callerAbort);
  }

  private record(
    pending: PendingInvocation,
    classification: EvidenceEvent['classification'],
    messageBytes?: number,
    source?: string,
    raw?: unknown,
  ): void {
    if (pending.events.length >= DEFAULT_EVENT_COUNT) return;
    const redacted =
      source === undefined
        ? undefined
        : raw === undefined
          ? redactTransportText(source, this.secrets)
          : redactEventEvidence(raw, this.agent.redaction?.event_pointers ?? [], this.secrets);
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
  }

  private recordClose(pending: PendingInvocation, close: WebSocketClose): void {
    pending.close = close;
    this.record(pending, 'connection_closed');
  }

  private evidence(
    pending: PendingInvocation,
    outcome: 'cancelled' | 'completed' | 'failed',
    classification?: WebSocketErrorClassification,
    close?: WebSocketClose,
  ): WebSocketAttemptEvidence {
    const base = {
      schema: WEBSOCKET_EVIDENCE_SCHEMA_VERSION,
      request_id: pending.requestId,
      lifecycle: this.agent.transport.lifecycle,
      connection_mode: this.agent.transport.connection_mode,
      acknowledgement: pending.acknowledged ? acknowledged : notAcknowledged,
      events: pending.events.slice(0, DEFAULT_EVENT_COUNT),
      ...((close ?? pending.close) === undefined ? {} : { close: close ?? pending.close }),
    } as const;
    if (outcome === 'completed') return { ...base, outcome };
    return {
      ...base,
      outcome,
      error_classification:
        outcome === 'cancelled' ? 'cancelled' : (classification ?? 'connection_failed'),
    } as WebSocketAttemptEvidence;
  }

  private attemptFailure(
    pending: PendingInvocation,
    error: AgentInvocationError,
    classification: WebSocketErrorClassification,
  ): InvocationAttempt {
    return {
      status: 'invocation_error',
      error,
      diagnostics: {},
      durationMs: pending.duration(),
      rawExcerpt: createRawExcerpt(
        redactTransportText(
          JSON.stringify(
            this.evidence(
              pending,
              classification === 'cancelled' ? 'cancelled' : 'failed',
              classification,
            ),
          ),
          this.secrets,
        ),
      ),
      warnings: [],
    };
  }

  private failureResult(
    pending: PendingInvocation,
    error: AgentInvocationError,
    classification: WebSocketErrorClassification,
    priorAttempts = pending.attempts,
  ): InvocationResult {
    const attempt = this.attemptFailure(pending, error, classification);
    return { ...attempt, attempts: [...priorAttempts, attempt] };
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
    this.clearPending(pending);
    pending.resolve(this.failureResult(pending, error, classification));
  }

  private settleSuccess(pending: PendingInvocation, response: AgentResponse): void {
    const report = parseAgentResponse(response);
    if (!report.ok) {
      this.settleFailure(
        pending,
        new AgentInvocationError(
          'invalid_envelope',
          'WebSocket extraction is not a valid agent response.',
        ),
        pending.trace === undefined ? 'result_extraction_failed' : 'trace_extraction_failed',
      );
      return;
    }
    const attempt: InvocationAttempt = {
      status: 'ok',
      raw: response,
      report,
      diagnostics: {},
      durationMs: pending.duration(),
      rawExcerpt: createRawExcerpt(
        redactTransportText(JSON.stringify(this.evidence(pending, 'completed')), this.secrets),
      ),
      warnings: report.warnings,
    };
    this.pending.delete(pending.requestId);
    this.remember(this.completed, pending.requestId);
    this.clearPending(pending);
    pending.resolve({ ...attempt, attempts: [...pending.attempts, attempt] });
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
    pending.attempts.push(this.attemptFailure(pending, error, classification));
    pending.retriesUsed += 1;
    this.clearPending(pending);
    pending.acknowledged = false;
    pending.trace = undefined;
    pending.duration = startTimer();
    pending.events = [];
    pending.messageCount = 0;
    pending.totalEvidenceBytes = 0;
    this.record(pending, 'retry_scheduled');
    try {
      await wait(
        retryDelay(this.agent, pending.retriesUsed - 1),
        pending.signal ?? this.options.signal,
      );
      if (!this.pending.has(pending.requestId)) return;
      this.record(pending, 'reconnect_started');
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
    const error = Object.assign(
      new AgentInvocationError('network', 'WebSocket disconnected before requests settled.'),
      { webSocketClassification: 'unexpected_close' as const },
    );
    for (const pending of [...this.pending.values()]) {
      this.recordClose(pending, close);
      void this.retryOrSettle(pending, error, 'unexpected_close');
    }
  }

  private startPing(connection: WebSocketConnection, generation: number): void {
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (generation !== this.connectionGeneration || this.connection !== connection) return;
      if (!connection.ping()) return;
      for (const pending of this.pending.values()) this.record(pending, 'ping_sent');
    }, this.agent.transport.ping_interval_ms);
  }

  private remember(target: Set<string>, requestId: string): void {
    target.add(requestId);
    if (target.size > MAX_TOMBSTONES) {
      const oldest = target.values().next().value;
      if (oldest !== undefined) target.delete(oldest);
    }
  }

  private failRun(error: AgentInvocationError): void {
    if (this.closed) return;
    this.closed = true;
    if (this.runTimer !== undefined) clearTimeout(this.runTimer);
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    for (const pending of [...this.pending.values()]) {
      this.settleFailure(pending, error, errorClassification(error));
    }
    this.connection?.destroy();
    this.connection = undefined;
    this.lifecycleController.abort();
  }

  private failScope(error: AgentInvocationError, scope?: ReadonlySet<string>): void {
    if (scope === undefined) {
      this.failRun(error);
      return;
    }
    for (const requestId of scope) {
      const pending = this.pending.get(requestId);
      if (pending !== undefined) {
        this.settleFailure(pending, error, errorClassification(error));
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
        throw Object.assign(
          new AgentInvocationError('timeout', 'WebSocket close handshake timed out.'),
          { webSocketClassification: 'close_timeout' as const },
        );
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
