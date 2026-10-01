import { isDeepStrictEqual } from 'node:util';

import { AGENT_PROTOCOL, type JsonValue } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { isJsonValue } from '../../internal/json-value.js';
import { extractRemoteError } from '../../internal/remote-error.js';
import { readJsonPointer } from '../http/json-pointer.js';
import type { StreamAgentResource } from './stream-adapter.js';

/** A terminal event mapped onto a native envelope; the adapter validates it before use. */
type CandidateResponse = Record<string, unknown>;

/** Maps application events to a terminal envelope, or undefined while the stream continues. */
type TerminalExtractor = (
  raw: unknown,
  eventName: string | undefined,
) => CandidateResponse | undefined;

const invalid = (message: string): AgentInvocationError =>
  new AgentInvocationError('invalid_envelope', message);

/**
 * Creates the per-attempt extractor. It owns incremental output so chunks from earlier events
 * can become the result when the terminal event has no result of its own.
 */
const createTerminalExtractor = (agent: StreamAgentResource): TerminalExtractor => {
  const { transport } = agent;
  let incrementalText = '';
  const incrementalArray: JsonValue[] = [];

  const accumulate = (payload: unknown): void => {
    if (transport.incremental_output_pointer === undefined) return;
    const chunk = readJsonPointer(payload, transport.incremental_output_pointer);
    if (transport.incremental_output_mode === 'text') {
      if (typeof chunk !== 'string') {
        throw invalid('Streaming text accumulation requires string chunks.');
      }
      incrementalText += chunk;
      return;
    }
    if (!isJsonValue(chunk)) throw invalid('Streaming array accumulation requires JSON chunks.');
    incrementalArray.push(chunk);
  };

  const terminalOutput = (payload: unknown): unknown => {
    const extracted = readJsonPointer(payload, transport.result_pointer);
    if (extracted !== undefined || transport.incremental_output_pointer === undefined) {
      return extracted;
    }
    return transport.incremental_output_mode === 'array' ? incrementalArray : incrementalText;
  };

  return (raw, eventName) => {
    if (transport.event_name !== undefined && eventName !== transport.event_name) return undefined;
    const payload =
      transport.event_data_pointer === undefined
        ? raw
        : readJsonPointer(raw, transport.event_data_pointer);
    if (payload === undefined) throw invalid('Streaming event data pointer did not resolve.');
    accumulate(payload);
    const terminal = readJsonPointer(payload, transport.terminal_pointer);
    if (!transport.terminal_values.some((value) => isDeepStrictEqual(value, terminal))) {
      return undefined;
    }
    const error = readJsonPointer(payload, transport.error_pointer);
    const trace = readJsonPointer(payload, transport.trace_pointer);
    const traceField = trace === undefined ? {} : { trace };
    if (error !== undefined && error !== null) {
      return {
        protocol: AGENT_PROTOCOL,
        error: extractRemoteError(error, 'The streaming agent reported an error.'),
        ...traceField,
      };
    }
    const output = terminalOutput(payload);
    if (!isJsonValue(output)) throw invalid('Streaming terminal result is not a JSON value.');
    return { protocol: AGENT_PROTOCOL, output, ...traceField };
  };
};

export { createTerminalExtractor, type CandidateResponse, type TerminalExtractor };
