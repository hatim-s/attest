import { isDeepStrictEqual } from 'node:util';

import type { AgentResource, JsonValue, WebSocketErrorClassification } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { isJsonValue } from '../../internal/json-value.js';
import { extractRemoteError } from '../../internal/remote-error.js';
import { readJsonPointer } from '../http/json-pointer.js';

type WebSocketAgentResource = AgentResource & {
  transport: Extract<AgentResource['transport'], { kind: 'websocket' }>;
};

type ServerEnvelope = {
  raw: unknown;
  requestId: string;
};

type EnvelopeFailure = {
  classification: WebSocketErrorClassification;
  error: AgentInvocationError;
};

type MessageTerminal =
  | { kind: 'error'; value: { code?: string; message: string } }
  | { kind: 'result'; value: JsonValue };

type MessageInterpretation = {
  acknowledgement: boolean;
  failure?: EnvelopeFailure;
  terminal?: MessageTerminal;
  trace?: JsonValue;
};

/** Maps transport failures onto the stable WebSocket evidence vocabulary. */
const errorClassification = (error: AgentInvocationError): WebSocketErrorClassification => {
  if (error.classification !== undefined) return error.classification;
  if (error.code === 'cancelled') return 'cancelled';
  if (error.code === 'timeout') return 'attempt_timeout';
  if (error.code === 'invalid_envelope') return 'invalid_json';
  return 'connection_failed';
};

/** Parses JSON and extracts the request id before session correlation. */
const parseServerEnvelope = (
  text: string,
  requestIdPointer: string,
): ServerEnvelope | EnvelopeFailure => {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (cause: unknown) {
    return {
      classification: 'invalid_json',
      error: new AgentInvocationError('invalid_envelope', 'WebSocket message is not valid JSON.', {
        cause,
      }),
    };
  }
  const requestId = readJsonPointer(raw, requestIdPointer);
  if (typeof requestId !== 'string') {
    return {
      classification: 'uncorrelated_server_work',
      error: new AgentInvocationError(
        'invalid_envelope',
        'WebSocket server work is missing a bounded correlation id.',
      ),
    };
  }
  return { raw, requestId };
};

/** Interprets one correlated envelope as progress, a terminal value, or a protocol failure. */
const interpretServerMessage = (
  raw: unknown,
  agent: WebSocketAgentResource,
  previouslyAcknowledged: boolean,
): MessageInterpretation => {
  const acknowledgementValue = readJsonPointer(raw, agent.transport.acknowledgement_pointer);
  const result = readJsonPointer(raw, agent.transport.result_pointer);
  const extractedError = readJsonPointer(raw, agent.transport.error_pointer);
  const rawTrace =
    agent.transport.trace_pointer === undefined
      ? undefined
      : readJsonPointer(raw, agent.transport.trace_pointer);
  const acknowledgement = agent.transport.acknowledgement_values.some((value) =>
    isDeepStrictEqual(value, acknowledgementValue),
  );

  if (rawTrace !== undefined && !isJsonValue(rawTrace)) {
    return {
      acknowledgement,
      failure: {
        classification: 'trace_extraction_failed',
        error: new AgentInvocationError('invalid_envelope', 'WebSocket trace extraction failed.'),
      },
    };
  }

  const progress = {
    acknowledgement,
    ...(rawTrace === undefined ? {} : { trace: rawTrace }),
  };
  const invalid = (
    classification: WebSocketErrorClassification,
    message: string,
  ): MessageInterpretation => ({
    ...progress,
    failure: {
      classification,
      error: new AgentInvocationError('invalid_envelope', message),
    },
  });
  const hasResult = result !== undefined;
  const hasError = extractedError !== undefined && extractedError !== null;
  if (hasResult && hasError) {
    return invalid(
      'result_extraction_failed',
      'WebSocket message contains both result and error values.',
    );
  }

  if ((hasResult || hasError) && !previouslyAcknowledged && !acknowledgement) {
    return invalid(
      'acknowledgement_extraction_failed',
      'WebSocket terminal message arrived before acknowledgement.',
    );
  }

  if (hasError) {
    return {
      ...progress,
      terminal: {
        kind: 'error',
        value: extractRemoteError(extractedError, 'The WebSocket agent reported an error.'),
      },
    };
  }
  if (hasResult) {
    if (!isJsonValue(result)) {
      return invalid('result_extraction_failed', 'WebSocket result extraction failed.');
    }
    return {
      ...progress,
      terminal: { kind: 'result', value: result },
    };
  }
  if (!acknowledgement && rawTrace === undefined) {
    return invalid(
      'acknowledgement_extraction_failed',
      'WebSocket acknowledgement extraction failed.',
    );
  }
  return progress;
};

export {
  errorClassification,
  interpretServerMessage,
  parseServerEnvelope,
  type WebSocketAgentResource,
};
