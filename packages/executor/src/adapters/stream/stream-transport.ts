import { AgentInvocationError, abortedError } from '../../errors.js';
import { LineSplitter } from '../../internal/line-splitter.js';
import { createRawExcerpt } from '../../internal/raw-excerpt.js';
import type { MaterializedHttpRequest } from '../http/request-template.js';
import { parseRetryAfter } from '../http/retry-after.js';
import { SseParser, type StreamEvent } from './sse-parser.js';
import type { StreamAgentResource, StreamInvokeOptions } from './stream-adapter.js';
import { StreamEvidence, capError, createStreamCaps } from './stream-evidence.js';
import {
  createTerminalExtractor,
  type CandidateResponse,
  type TerminalExtractor,
} from './stream-terminal.js';

/** A response whose lifetime and network policy belong to the host transport. */
type StreamHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  cancel: () => void;
};

/** Opens a guarded HTTP stream without changing Attest framing or terminal extraction. */
type StreamHttpTransport = (
  agent: StreamAgentResource,
  request: MaterializedHttpRequest,
  signal: AbortSignal,
  options: StreamInvokeOptions,
) => Promise<StreamHttpResponse>;

type ConsumedStream = {
  response: CandidateResponse;
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
const parseEventData = (source: string, framing: 'sse' | 'jsonl'): unknown => {
  try {
    return JSON.parse(source) as unknown;
  } catch (error: unknown) {
    const message =
      framing === 'sse' ? 'SSE data is not valid JSON.' : 'JSONL stream contains non-JSON data.';
    throw new AgentInvocationError('invalid_envelope', message, { cause: error });
  }
};

/** Reads one HTTP stream with separate transport/application idle clocks and hard event caps. */
const consumeResponse = async (
  response: StreamHttpResponse,
  options: ConsumeOptions,
): Promise<ConsumedStream> => {
  const { agent, signal } = options;
  const { framing } = agent.transport;
  const caps = createStreamCaps(agent);
  const evidence = new StreamEvidence(agent, caps, options.secrets);
  const sse = framing === 'sse' ? new SseParser() : undefined;
  const splitter = new LineSplitter(caps.eventBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let totalBytes = 0;
  let interruption: AgentInvocationError | undefined;
  let transportIdle: NodeJS.Timeout | undefined;
  let applicationIdle: NodeJS.Timeout | undefined;

  // Destroying the response ends the read loop; `interruption` records why it was stopped.
  const interrupt = (error: AgentInvocationError): void => {
    interruption ??= error;
    response.cancel();
  };
  const resetTransportIdle = (): void => {
    clearTimeout(transportIdle);
    transportIdle = setTimeout(
      () => interrupt(new AgentInvocationError('timeout', 'Streaming transport became idle.')),
      caps.idleMs,
    );
  };
  const resetApplicationIdle = (): void => {
    clearTimeout(applicationIdle);
    applicationIdle = setTimeout(
      () => interrupt(new AgentInvocationError('timeout', 'Streaming application became idle.')),
      caps.idleMs,
    );
  };
  const abort = (): void => interrupt(abortedError(options.callerSignal, 'Streaming invocation'));

  /** Records one event and returns the terminal envelope once it arrives. */
  const acceptEvent = (event: StreamEvent): CandidateResponse | undefined => {
    if (event.heartbeat) {
      evidence.record(event);
      if (agent.transport.heartbeat_resets_application_idle === true) resetApplicationIdle();
      return undefined;
    }
    const raw = parseEventData(event.source, framing);
    evidence.record(event, raw);
    resetApplicationIdle();
    try {
      return options.extractTerminal(raw, event.eventName);
    } catch (error: unknown) {
      if (error instanceof AgentInvocationError) throw error;
      throw new AgentInvocationError('invalid_envelope', 'Streaming event could not be decoded.', {
        cause: error,
      });
    }
  };

  const acceptLine = (line: string): CandidateResponse | undefined => {
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
  const acceptLines = (text: string, final: boolean): CandidateResponse | undefined => {
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

  const completed = (terminal: CandidateResponse): ConsumedStream => ({
    response: terminal,
    evidence: evidence.text,
    applicationStarted: evidence.applicationStarted,
  });

  signal.addEventListener('abort', abort, { once: true });
  resetTransportIdle();
  resetApplicationIdle();
  if (signal.aborted) abort();
  try {
    for await (const chunk of response.body) {
      resetTransportIdle();
      totalBytes += chunk.byteLength;
      if (totalBytes > caps.totalBytes) {
        throw capError('Streaming response exceeds its aggregate evidence cap.');
      }
      const terminal = acceptLines(decode(chunk), false);
      if (terminal !== undefined) return completed(terminal);
    }
    const trailing = decode();
    const terminal = acceptLines(trailing, false) ?? acceptLines('', true);
    if (terminal !== undefined) return completed(terminal);
    throw new AgentInvocationError(
      'invalid_envelope',
      'Streaming response closed without a terminal result.',
    );
  } catch (error: unknown) {
    const failure =
      interruption ??
      (error instanceof AgentInvocationError
        ? error
        : new AgentInvocationError('network', 'Streaming response failed.', { cause: error }));
    failure.applicationStarted = evidence.applicationStarted;
    failure.rawExcerpt = createRawExcerpt(evidence.text);
    throw failure;
  } finally {
    clearTimeout(transportIdle);
    clearTimeout(applicationIdle);
    signal.removeEventListener('abort', abort);
    response.cancel();
  }
};

const contentType = (response: StreamHttpResponse): string | undefined =>
  String(response.headers['content-type'] ?? '')
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase();

/** Performs one DNS-pinned stream request and returns only after terminal extraction. */
const streamOnce = async (
  agent: StreamAgentResource,
  materialized: MaterializedHttpRequest,
  signal: AbortSignal,
  options: StreamInvokeOptions,
): Promise<ConsumedStream & { status: number }> => {
  const open = options.requestStream ?? (await import('./node-stream-request.js')).openNodeStream;
  const response = await open(agent, materialized, signal, options);
  const { status } = response;
  if (status < 200 || status >= 300) {
    response.cancel();
    throw new AgentInvocationError('http_status', `Streaming HTTP returned status ${status}.`, {
      httpStatus: status,
      retryAfterMs: parseRetryAfter(response.headers['retry-after']),
    });
  }
  if (agent.transport.framing === 'sse' && contentType(response) !== 'text/event-stream') {
    response.cancel();
    throw new AgentInvocationError(
      'invalid_envelope',
      'SSE response must use the text/event-stream content type.',
    );
  }
  const consumed = await consumeResponse(response, {
    agent,
    signal,
    callerSignal: options.signal,
    secrets: options.secrets ?? [],
    extractTerminal: createTerminalExtractor(agent),
  });
  return { ...consumed, status };
};

export { streamOnce, type StreamHttpTransport, type StreamHttpResponse };
