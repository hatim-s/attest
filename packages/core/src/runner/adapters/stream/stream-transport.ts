import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isDeepStrictEqual } from 'node:util';

import {
  AGENT_PROTOCOL,
  type AgentRequest,
  type AgentResponse,
  type JsonValue,
} from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { createRawExcerpt } from '../../internal/raw-excerpt.js';
import { readJsonPointer } from '../http/json-pointer.js';
import { materializeHttpRequest } from '../http/request-template.js';
import { redactEventEvidence, redactTransportText } from '../http/redaction.js';
import { parseRetryAfter } from '../http/retry-after.js';
import { resolveSafeHttpUrl } from '../http/url-security.js';
import { SseParser } from './sse-parser.js';
import type {
  StreamAgentResource,
  StreamEvent,
  StreamFailure,
  StreamInvokeOptions,
} from './types.js';

const DEFAULT_CONNECT_MS = 10_000;
const DEFAULT_FIRST_BYTE_MS = 30_000;
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_EVENT_COUNT = 10_000;
const DEFAULT_EVENT_BYTES = 1024 * 1024;
const DEFAULT_TOTAL_BYTES = 10 * 1024 * 1024;

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === 'object' && Object.values(value as Record<string, unknown>).every(isJsonValue)
  );
};

const extractedError = (value: unknown): { code?: string; message: string } => {
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
  return { message: 'The streaming agent reported an error.' };
};

/** Reads one HTTP stream with separate transport/application idle clocks and hard event caps. */
const consumeResponse = async (
  response: IncomingMessage,
  agent: StreamAgentResource,
  signal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  secrets: readonly string[],
  onEvent: (event: StreamEvent) => AgentResponse | undefined,
): Promise<{ response: AgentResponse; evidence: string; applicationStarted: boolean }> =>
  new Promise((resolve, reject) => {
    const transport = agent.transport;
    const maximumEventBytes = agent.limits?.event_bytes ?? DEFAULT_EVENT_BYTES;
    const maximumEventCount = agent.limits?.event_count ?? DEFAULT_EVENT_COUNT;
    const maximumTotalBytes = agent.limits?.total_evidence_bytes ?? DEFAULT_TOTAL_BYTES;
    const idleMs = agent.timeouts?.idle_ms ?? DEFAULT_IDLE_MS;
    const sse = transport.framing === 'sse' ? new SseParser() : undefined;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    let evidence = '';
    let eventCount = 0;
    let totalBytes = 0;
    let applicationStarted = false;
    let settled = false;
    let transportIdle: NodeJS.Timeout;
    let applicationIdle: NodeJS.Timeout;

    const fail = (error: StreamFailure): void => {
      error.applicationStarted = applicationStarted;
      error.rawExcerpt = createRawExcerpt(evidence);
      finish(() => reject(error));
    };
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(transportIdle);
      clearTimeout(applicationIdle);
      signal.removeEventListener('abort', abort);
      response.destroy();
      operation();
    };
    const resetTransportIdle = (): void => {
      clearTimeout(transportIdle);
      transportIdle = setTimeout(
        () => fail(new AgentInvocationError('timeout', 'Streaming transport became idle.')),
        idleMs,
      );
    };
    const resetApplicationIdle = (): void => {
      clearTimeout(applicationIdle);
      applicationIdle = setTimeout(
        () => fail(new AgentInvocationError('timeout', 'Streaming application became idle.')),
        idleMs,
      );
    };
    const abort = (): void =>
      fail(
        new AgentInvocationError(
          callerSignal?.aborted === true ? 'cancelled' : 'timeout',
          callerSignal?.aborted === true
            ? 'Streaming invocation was cancelled.'
            : 'Streaming invocation timed out.',
        ),
      );
    const accept = (event: StreamEvent): void => {
      if (Buffer.byteLength(event.source) > maximumEventBytes) {
        fail(
          new AgentInvocationError(
            'output_cap_exceeded',
            'Streaming response event exceeds its event byte cap.',
          ),
        );
        return;
      }
      eventCount += 1;
      if (eventCount > maximumEventCount) {
        fail(
          new AgentInvocationError(
            'output_cap_exceeded',
            'Streaming response exceeds its event count cap.',
          ),
        );
        return;
      }
      if (event.heartbeat) {
        evidence += `${redactTransportText(event.source, secrets)}\n`;
        if (transport.heartbeat_resets_application_idle === true) resetApplicationIdle();
        return;
      }
      evidence += `${redactEventEvidence(
        event.raw,
        agent.redaction?.event_pointers ?? [],
        secrets,
      )}\n`;
      applicationStarted = true;
      resetApplicationIdle();
      let terminal: AgentResponse | undefined;
      try {
        terminal = onEvent(event);
      } catch (error: unknown) {
        fail(
          error instanceof AgentInvocationError
            ? error
            : new AgentInvocationError(
                'invalid_envelope',
                'Streaming event could not be decoded.',
                { cause: error },
              ),
        );
        return;
      }
      if (terminal !== undefined)
        finish(() => resolve({ response: terminal, evidence, applicationStarted }));
    };
    const consumeLine = (line: string): void => {
      if (Buffer.byteLength(line) > maximumEventBytes) {
        fail(
          new AgentInvocationError(
            'output_cap_exceeded',
            'Streaming response line exceeds its event byte cap.',
          ),
        );
        return;
      }
      if (sse !== undefined) {
        if (line === '' && sse.bufferedDataBytes > maximumEventBytes) {
          fail(
            new AgentInvocationError(
              'output_cap_exceeded',
              'Streaming response event exceeds its event byte cap.',
            ),
          );
          return;
        }
        try {
          const event = sse.push(line);
          if (event !== undefined) accept(event);
        } catch (error: unknown) {
          fail(
            new AgentInvocationError('invalid_envelope', 'SSE data is not valid JSON.', {
              cause: error,
            }),
          );
        }
      } else if (line.trim().length > 0) {
        try {
          accept({ heartbeat: false, raw: JSON.parse(line) as unknown, source: line });
        } catch (error: unknown) {
          fail(
            new AgentInvocationError('invalid_envelope', 'JSONL stream contains non-JSON data.', {
              cause: error,
            }),
          );
        }
      }
    };

    signal.addEventListener('abort', abort, { once: true });
    response.on('data', (chunk: Buffer) => {
      if (settled) return;
      resetTransportIdle();
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumTotalBytes) {
        fail(
          new AgentInvocationError(
            'output_cap_exceeded',
            'Streaming response exceeds its aggregate evidence cap.',
          ),
        );
        return;
      }
      try {
        buffer += decoder.decode(chunk, { stream: true });
      } catch (error: unknown) {
        fail(
          new AgentInvocationError('invalid_envelope', 'Streaming response is not valid UTF-8.', {
            cause: error,
          }),
        );
        return;
      }
      if (Buffer.byteLength(buffer) > maximumEventBytes && !buffer.includes('\n')) {
        fail(
          new AgentInvocationError(
            'output_cap_exceeded',
            'Streaming response line exceeds its event byte cap.',
          ),
        );
        return;
      }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        buffer = buffer.slice(newline + 1);
        consumeLine(line);
        if (settled) return;
      }
    });
    response.once('error', (error) =>
      fail(new AgentInvocationError('network', 'Streaming response failed.', { cause: error })),
    );
    response.once('end', () => {
      try {
        buffer += decoder.decode();
      } catch (error: unknown) {
        fail(
          new AgentInvocationError('invalid_envelope', 'Streaming response is not valid UTF-8.', {
            cause: error,
          }),
        );
        return;
      }
      if (buffer.length > 0) consumeLine(buffer.replace(/\r$/u, ''));
      if (!settled)
        fail(
          new AgentInvocationError(
            'invalid_envelope',
            'Streaming response closed without a terminal result.',
          ),
        );
    });
    resetTransportIdle();
    resetApplicationIdle();
    if (signal.aborted) abort();
  });

/** Performs one DNS-pinned stream request and returns only after terminal extraction. */
const streamOnce = async (
  agent: StreamAgentResource,
  request: AgentRequest,
  materialized: ReturnType<typeof materializeHttpRequest>,
  signal: AbortSignal,
  options: StreamInvokeOptions,
): Promise<{
  response: AgentResponse;
  evidence: string;
  applicationStarted: boolean;
  status: number;
}> => {
  const resolved = await resolveSafeHttpUrl(
    materialized.url,
    agent.timeouts?.connect_ms ?? DEFAULT_CONNECT_MS,
    signal,
    options.signal,
  );
  if (
    (options.secrets?.length ?? 0) > 0 &&
    resolved.url.protocol !== 'https:' &&
    !resolved.loopback
  ) {
    throw new AgentInvocationError(
      'network',
      'Streaming secrets require HTTPS except on loopback.',
    );
  }
  const transport = resolved.url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timers: { firstByte?: NodeJS.Timeout } = {};
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      if (timers.firstByte !== undefined) clearTimeout(timers.firstByte);
      signal.removeEventListener('abort', abort);
      operation();
    };
    const abort = (): void => {
      outgoing.destroy();
      finish(() =>
        reject(
          new AgentInvocationError(
            options.signal?.aborted === true ? 'cancelled' : 'timeout',
            options.signal?.aborted === true
              ? 'Streaming invocation was cancelled.'
              : 'Streaming invocation timed out.',
          ),
        ),
      );
    };
    const outgoing = transport(
      resolved.url,
      {
        method: materialized.method,
        headers: materialized.headers,
        lookup: (_hostname, _options, callback) =>
          callback(null, resolved.address, resolved.family),
      },
      (response) => {
        if (timers.firstByte !== undefined) clearTimeout(timers.firstByte);
        outgoing.setTimeout(0);
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.destroy();
          const error = Object.assign(
            new AgentInvocationError(
              'http_status',
              `Streaming HTTP returned status ${String(status)}.`,
            ),
            {
              httpStatus: status,
              retryAfterMs: parseRetryAfter(response.headersDistinct['retry-after']?.[0]),
            },
          ) as StreamFailure;
          finish(() => reject(error));
          return;
        }
        const contentType = String(response.headers['content-type'] ?? '')
          .split(';', 1)[0]
          ?.trim()
          .toLowerCase();
        if (agent.transport.framing === 'sse' && contentType !== 'text/event-stream') {
          response.destroy();
          finish(() =>
            reject(
              new AgentInvocationError(
                'invalid_envelope',
                'SSE response must use the text/event-stream content type.',
              ),
            ),
          );
          return;
        }
        let incrementalText = '';
        const incrementalArray: JsonValue[] = [];
        void consumeResponse(
          response,
          agent,
          signal,
          options.signal,
          options.secrets ?? [],
          (event) => {
            if (
              agent.transport.event_name !== undefined &&
              event.eventName !== agent.transport.event_name
            )
              return undefined;
            const payload =
              agent.transport.event_data_pointer === undefined
                ? event.raw
                : readJsonPointer(event.raw, agent.transport.event_data_pointer);
            if (payload === undefined)
              throw new AgentInvocationError(
                'invalid_envelope',
                'Streaming event data pointer did not resolve.',
              );
            if (agent.transport.incremental_output_pointer !== undefined) {
              const chunk = readJsonPointer(payload, agent.transport.incremental_output_pointer);
              if (agent.transport.incremental_output_mode === 'text') {
                if (typeof chunk !== 'string')
                  throw new AgentInvocationError(
                    'invalid_envelope',
                    'Streaming text accumulation requires string chunks.',
                  );
                incrementalText += chunk;
              } else {
                incrementalArray.push(chunk as JsonValue);
              }
            }
            const terminal = readJsonPointer(payload, agent.transport.terminal_pointer);
            if (
              !agent.transport.terminal_values.some((value) => isDeepStrictEqual(value, terminal))
            )
              return undefined;
            const error =
              agent.transport.error_pointer === undefined
                ? undefined
                : readJsonPointer(payload, agent.transport.error_pointer);
            const trace =
              agent.transport.trace_pointer === undefined
                ? undefined
                : readJsonPointer(payload, agent.transport.trace_pointer);
            if (error !== undefined && error !== null) {
              return {
                protocol: AGENT_PROTOCOL,
                error: extractedError(error),
                ...(trace === undefined ? {} : { trace }),
              } as AgentResponse;
            }
            const extracted = readJsonPointer(payload, agent.transport.result_pointer);
            const output =
              extracted === undefined && agent.transport.incremental_output_pointer !== undefined
                ? agent.transport.incremental_output_mode === 'array'
                  ? incrementalArray
                  : incrementalText
                : extracted;
            if (!isJsonValue(output))
              throw new AgentInvocationError(
                'invalid_envelope',
                'Streaming terminal result is not a JSON value.',
              );
            return {
              protocol: AGENT_PROTOCOL,
              output,
              ...(trace === undefined ? {} : { trace }),
            } as AgentResponse;
          },
        ).then(
          (completed) => finish(() => resolve({ ...completed, status })),
          (error: unknown) =>
            finish(() =>
              reject(error instanceof Error ? error : new Error('Streaming response failed.')),
            ),
        );
      },
    );
    outgoing.once('error', (error) =>
      finish(() =>
        reject(
          new AgentInvocationError('network', 'Streaming HTTP transport failed.', { cause: error }),
        ),
      ),
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    timers.firstByte = setTimeout(() => {
      outgoing.destroy();
      finish(() =>
        reject(new AgentInvocationError('timeout', 'Streaming HTTP first byte timed out.')),
      );
    }, agent.timeouts?.first_byte_ms ?? DEFAULT_FIRST_BYTE_MS);
    outgoing.setTimeout(agent.timeouts?.connect_ms ?? DEFAULT_CONNECT_MS, () => {
      outgoing.destroy();
      finish(() =>
        reject(new AgentInvocationError('timeout', 'Streaming HTTP connection timed out.')),
      );
    });
    if (materialized.body !== undefined) outgoing.write(materialized.body);
    outgoing.end();
  });
};

export { streamOnce };
