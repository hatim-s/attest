import * as Effect from 'effect/Effect';
import { awaitAbort, httpSync, withHttpCleanup } from '../http/http-effects.js';
import type { JsonValue } from '@attest/contracts';
import type { AgentResponseCandidate } from '../../internal/agent-response-candidate.js';
import { parseJson } from '../../internal/json-value.js';
import { AgentInvocationError, abortedError } from '../../errors.js';
import { LineSplitter } from '../../internal/line-splitter.js';
import { createRawExcerpt } from '../../internal/raw-excerpt.js';
import type { MaterializedHttpRequest } from '../http/request-template.js';
import { parseRetryAfter } from '../http/retry-after.js';
import { SseParser, type StreamEvent } from './sse-parser.js';
import type { StreamAgentResource, StreamInvokeOptions } from './stream-adapter.js';
import { StreamEvidence, capError, createStreamCaps } from './stream-evidence.js';
import { createTerminalExtractor, type TerminalExtractor } from './stream-terminal.js';

/** A response whose lifetime and network policy belong to the host transport. */
type StreamHttpResponse = {
  status: number;
  headers: Record<string, string>;
  /** Reads one chunk. The owner must close even after EOF, failure or interruption. */
  read: Effect.Effect<IteratorResult<Uint8Array>, AgentInvocationError>;
  /** Completes only after confirmed release, or fails with retained cleanup evidence. */
  close: Effect.Effect<void, unknown>;
};

/** Opens a guarded HTTP stream without changing Attest framing or terminal extraction. */
type StreamHttpTransport = (
  agent: StreamAgentResource,
  request: MaterializedHttpRequest,
  signal: AbortSignal,
  options: StreamInvokeOptions,
) => Effect.Effect<StreamHttpResponse, AgentInvocationError>;

type ConsumedStream = {
  response: AgentResponseCandidate;
  evidence: string;
  applicationStarted: boolean;
};

type ConsumeOptions = {
  agent: StreamAgentResource;
  signal: AbortSignal;
  callerSignal: AbortSignal | undefined;
  secrets: readonly string[];
  extractTerminal: TerminalExtractor;
};

/** Parses one event payload; SSE and JSONL report bad JSON under their own framing name. */
const parseEventData = (source: string, framing: 'sse' | 'jsonl'): JsonValue => {
  try {
    return parseJson(source);
  } catch (error: unknown) {
    const message =
      framing === 'sse' ? 'SSE data is not valid JSON.' : 'JSONL stream contains non-JSON data.';

    throw new AgentInvocationError('invalid_envelope', message, { cause: error });
  }
};

/** Reads one HTTP stream with separate transport/application idle clocks and hard event caps. */
const consumeResponse = Effect.fn('stream.consume')(function* (
  response: StreamHttpResponse,
  options: ConsumeOptions,
) {
  const { agent, signal } = options;
  const { framing } = agent.transport;
  const caps = createStreamCaps(agent);
  const evidence = new StreamEvidence(agent, caps, options.secrets);
  const sse = framing === 'sse' ? new SseParser() : undefined;
  const splitter = new LineSplitter(caps.eventBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let totalBytes = 0;
  let transportAt = Date.now();
  let applicationAt = transportAt;

  /** Records one event and returns the terminal envelope once it arrives. */
  const acceptEvent = (event: StreamEvent): AgentResponseCandidate | undefined => {
    if (event.heartbeat) {
      evidence.recordHeartbeat(event.source);

      if (agent.transport.heartbeat_resets_application_idle === true) applicationAt = Date.now();

      return undefined;
    }

    const raw = parseEventData(event.source, framing);
    evidence.recordEvent(event.source, raw);
    applicationAt = Date.now();

    return options.extractTerminal(raw, event.eventName);
  };

  const acceptLine = (line: string): AgentResponseCandidate | undefined => {
    if (sse === undefined) {
      if (line.trim().length === 0) return undefined;

      return acceptEvent({ heartbeat: false, source: line });
    }

    if (line === '' && sse.bufferedDataBytes > caps.eventBytes) {
      throw capError('Streaming response event exceeds its event byte cap.');
    }

    const event = sse.push(line);

    return event === undefined ? undefined : acceptEvent(event);
  };

  /** Feeds split lines in order and stops at the first terminal event. */
  const acceptLines = (text: string, final: boolean): AgentResponseCandidate | undefined => {
    const split = final ? splitter.end() : splitter.push(text);

    for (const line of split.lines) {
      const terminal = acceptLine(line);

      if (terminal !== undefined) return terminal;
    }

    if (split.overflow) throw capError('Streaming response line exceeds its event byte cap.');

    return undefined;
  };

  const decode = (chunk?: Uint8Array): string => {
    try {
      return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true });
    } catch (error: unknown) {
      throw new AgentInvocationError('invalid_envelope', 'Streaming response is not valid UTF-8.', {
        cause: error,
      });
    }
  };

  const completed = (terminal: AgentResponseCandidate): ConsumedStream => {
    if (signal.aborted) throw abortedError(options.callerSignal, 'Streaming invocation');

    return {
      response: terminal,
      evidence: evidence.text,
      applicationStarted: evidence.applicationStarted,
    };
  };

  const primary = Effect.gen(function* () {
    for (;;) {
      if (signal.aborted)
        return yield* Effect.fail(abortedError(options.callerSignal, 'Streaming invocation'));
      const now = Date.now();
      const transportRemaining = caps.idleMs - (now - transportAt);
      const applicationRemaining = caps.idleMs - (now - applicationAt);
      const applicationFirst = applicationRemaining <= transportRemaining;
      const remaining = Math.max(0, Math.min(transportRemaining, applicationRemaining));

      const item = yield* Effect.raceFirst(
        response.read.pipe(
          Effect.timeoutOrElse({
            duration: remaining,
            orElse: () =>
              Effect.fail(
                new AgentInvocationError(
                  'timeout',
                  applicationFirst
                    ? 'Streaming application became idle.'
                    : 'Streaming transport became idle.',
                ),
              ),
          }),
        ),
        awaitAbort(signal).pipe(
          Effect.andThen(() =>
            Effect.fail(abortedError(options.callerSignal, 'Streaming invocation')),
          ),
        ),
      );

      if (signal.aborted)
        return yield* Effect.fail(abortedError(options.callerSignal, 'Streaming invocation'));

      if (item.done) break;
      transportAt = Date.now();
      const chunk = item.value;
      totalBytes += chunk.byteLength;

      if (totalBytes > caps.totalBytes)
        return yield* Effect.fail(
          capError('Streaming response exceeds its aggregate evidence cap.'),
        );
      const terminal = yield* httpSync(() => acceptLines(decode(chunk), false));

      if (terminal !== undefined) return yield* httpSync(() => completed(terminal));
    }

    const terminal = yield* httpSync(() => acceptLines(decode(), false) ?? acceptLines('', true));

    if (terminal !== undefined) return yield* httpSync(() => completed(terminal));

    return yield* Effect.fail(
      new AgentInvocationError(
        'invalid_envelope',
        'Streaming response closed without a terminal result.',
      ),
    );
  });

  return yield* primary.pipe(
    Effect.mapError(
      (failure) =>
        new AgentInvocationError(failure.code, failure.message, {
          cause: failure,
          // A read failure cannot establish that dispatch did not reach the peer.
          applicationStarted: true,
          rawExcerpt: createRawExcerpt(evidence.text),
        }),
    ),
  );
});

const contentType = (response: StreamHttpResponse): string | undefined =>
  String(response.headers['content-type'] ?? '')
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase();

/** Performs one DNS-pinned stream request and returns only after terminal extraction. */
const streamOnce = Effect.fn('stream.once')(function* (
  agent: StreamAgentResource,
  materialized: MaterializedHttpRequest,
  signal: AbortSignal,
  options: StreamInvokeOptions,
) {
  const open =
    options.requestStream ??
    (yield* Effect.promise(() => import('./node-stream-request.js'))).openNodeStream;

  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const response = yield* open(agent, materialized, signal, options).pipe(
        Effect.mapError((error) =>
          signal.aborted
            ? abortedError(options.signal, 'Streaming invocation', {
                cause: error,
                applicationStarted: error.applicationStarted,
                rawExcerpt: error.rawExcerpt,
              })
            : error,
        ),
      );

      const { status } = response;
      let completed: (ConsumedStream & { status: number }) | undefined;

      return yield* withHttpCleanup(
        restore(
          Effect.gen(function* () {
            if (status < 200 || status >= 300) {
              return yield* Effect.fail(
                new AgentInvocationError(
                  'http_status',
                  `Streaming HTTP returned status ${status}.`,
                  {
                    httpStatus: status,
                    retryAfterMs: parseRetryAfter(response.headers['retry-after']),
                  },
                ),
              );
            }

            if (
              agent.transport.framing === 'sse' &&
              contentType(response) !== 'text/event-stream'
            ) {
              return yield* Effect.fail(
                new AgentInvocationError(
                  'invalid_envelope',
                  'SSE response must use the text/event-stream content type.',
                ),
              );
            }

            const consumed = yield* consumeResponse(response, {
              agent,
              signal,
              callerSignal: options.signal,
              secrets: options.secrets ?? [],
              extractTerminal: createTerminalExtractor(agent),
            });

            completed = { ...consumed, status };

            return completed;
          }),
        ),
        [response.close],
      ).pipe(
        Effect.mapError((error) => {
          // Cleanup after a terminal keeps its redacted evidence alongside the release Cause.
          return completed === undefined
            ? error
            : new AgentInvocationError(error.code, error.message, {
                ...error,
                cause: error.cause,
                rawExcerpt: createRawExcerpt(completed.evidence),
                httpStatus: completed.status,
              });
        }),
      );
    }),
  );
});

export { streamOnce, type StreamHttpTransport, type StreamHttpResponse };
