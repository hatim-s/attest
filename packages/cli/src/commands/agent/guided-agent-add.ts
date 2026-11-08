import * as Effect from 'effect/Effect';
import type { AgentAddFields } from '@attest/local/agent';

import { AttestCliError } from '../../errors/cli-error.js';
import { commaSeparated, promptChoice, promptDefault, promptOptional } from './agent-prompts.js';
import { ask, requiredInput, type PromptContext } from '../shared/required-input.js';

type GuidedTransport = 'background' | 'cli' | 'http' | 'jsonl' | 'stream' | 'websocket';

const TRANSPORT_FLAGS = [
  'argvJson',
  'backgroundCommand',
  'jsonlCommand',
  'nativeCommand',
  'nativeHttp',
  'streamUrl',
  'webSocketUrl',
] as const satisfies readonly (keyof AgentAddFields)[];

const readTransport = Effect.fn('readTransport')(function* (
  context: PromptContext,
): Effect.fn.Return<GuidedTransport, Error> {
  const answer = (yield* ask(context, 'Transport [cli/http/background/jsonl/stream/websocket]: '))
    .trim()
    .toLowerCase();

  if (answer === '') return 'cli';

  const transports: readonly GuidedTransport[] = [
    'background',
    'cli',
    'http',
    'jsonl',
    'stream',
    'websocket',
  ];

  const transport = transports.find((candidate) => candidate === answer);

  if (transport !== undefined) return transport;

  return yield* new AttestCliError(
    'cli_usage',
    'Transport must be cli, http, background, jsonl, stream, or websocket.',
    { path: 'transport' },
  );
});

const promptBackgroundFields = Effect.fn('promptBackgroundFields')(function* (
  context: PromptContext,
): Effect.fn.Return<Partial<AgentAddFields>, Error> {
  return {
    backgroundCommand: yield* requiredInput(
      undefined,
      { path: '--background-command', question: 'Background start command: ' },
      context,
    ),
    readinessHttp: yield* requiredInput(
      undefined,
      { path: '--readiness-http', question: 'Readiness HTTP URL: ' },
      context,
    ),
    invokeUrl: yield* requiredInput(
      undefined,
      { path: '--invoke-url', question: 'Invoke HTTP URL: ' },
      context,
    ),
    responsePointer: yield* promptDefault(undefined, 'Result JSON Pointer', '/output', context),
    stopTimeout: yield* promptDefault(undefined, 'Stop timeout', '5s', context),
  };
});

const promptJsonlFields = Effect.fn('promptJsonlFields')(function* (
  context: PromptContext,
): Effect.fn.Return<Partial<AgentAddFields>, Error> {
  return {
    jsonlCommand: yield* requiredInput(
      undefined,
      { path: '--jsonl-command', question: 'JSONL bridge command: ' },
      context,
    ),
    bridgeConcurrency: yield* promptChoice(
      'Bridge concurrency',
      ['serial', 'multiplexed'],
      'serial',
      '--bridge-concurrency',
      context,
    ),
    cancellationGrace: yield* promptDefault(undefined, 'Cancellation grace', '1s', context),
  };
});

const promptStreamFields = Effect.fn('promptStreamFields')(function* (
  context: PromptContext,
): Effect.fn.Return<Partial<AgentAddFields>, Error> {
  return {
    streamUrl: yield* requiredInput(
      undefined,
      { path: '--stream-url', question: 'Stream HTTP URL: ' },
      context,
    ),
    streamFraming: yield* promptChoice(
      'Stream framing',
      ['sse', 'jsonl'],
      'sse',
      '--stream-framing',
      context,
    ),
    terminalPointer: yield* promptDefault(undefined, 'Terminal JSON Pointer', '/type', context),
    terminalValues: [yield* promptDefault(undefined, 'Terminal JSON value', '"result"', context)],
    responsePointer: yield* promptDefault(undefined, 'Result JSON Pointer', '/output', context),
  };
});

const promptWebSocketFields = Effect.fn('promptWebSocketFields')(function* (
  context: PromptContext,
): Effect.fn.Return<Partial<AgentAddFields>, Error> {
  const webSocketUrl = yield* requiredInput(
    undefined,
    { path: '--websocket-url', question: 'WebSocket URL: ' },
    context,
  );

  const webSocketLifecycle = yield* promptChoice(
    'WebSocket lifecycle',
    ['per_run', 'per_case'],
    'per_run',
    '--websocket-lifecycle',
    context,
  );

  const connectionMode = yield* promptChoice(
    'Connection mode',
    ['serial', 'multiplexed'],
    webSocketLifecycle === 'per_case' ? 'serial' : 'multiplexed',
    '--connection-mode',
    context,
  );

  return {
    webSocketUrl,
    webSocketLifecycle,
    connectionMode,
    headerEnv: commaSeparated(
      yield* ask(context, 'Header environment references HEADER=ENV, comma-separated [none]: '),
    ),
    webSocketSubprotocol: yield* promptOptional(undefined, 'WebSocket subprotocol', context),
    requestTemplate: yield* promptDefault(
      undefined,
      'Request template JSON',
      '{"request_id":"{{request_id}}","request":"{{request}}"}',
      context,
    ),
    requestIdPointer: yield* promptDefault(
      undefined,
      'Request id JSON Pointer',
      '/request_id',
      context,
    ),
    acknowledgementPointer: yield* promptDefault(
      undefined,
      'Acknowledgement JSON Pointer',
      '/type',
      context,
    ),
    acknowledgementValues: [
      yield* promptDefault(undefined, 'Acknowledgement JSON value', '"acknowledgement"', context),
    ],
    responsePointer: yield* promptDefault(undefined, 'Result JSON Pointer', '/output', context),
    errorPointer: yield* promptDefault(undefined, 'Error JSON Pointer', '/error', context),
    tracePointer: yield* promptOptional(undefined, 'Trace JSON Pointer', context),
    openTimeout: yield* promptDefault(undefined, 'Open timeout', '10s', context),
    idleTimeout: yield* promptDefault(undefined, 'Message idle timeout', '30s', context),
    attemptTimeout: yield* promptDefault(undefined, 'Attempt timeout', '60s', context),
    pingInterval: yield* promptDefault(undefined, 'Ping interval', '15s', context),
    closeTimeout: yield* promptDefault(undefined, 'Close timeout', '5s', context),
  };
});

/**
 * Asks for the transport and its fields when no transport flag was passed. The answers replace
 * the matching flags; everything else the user passed is kept as-is.
 */
const promptTransportFields = Effect.fn('promptTransportFields')(function* (
  fields: AgentAddFields,
  context: PromptContext,
): Effect.fn.Return<AgentAddFields, Error> {
  if (!context.interactive || TRANSPORT_FLAGS.some((flag) => fields[flag] !== undefined)) {
    return fields;
  }

  switch (yield* readTransport(context)) {
    case 'cli':
      return {
        ...fields,
        nativeCommand: yield* requiredInput(
          undefined,
          { path: '--native-command', question: 'Native command: ' },
          context,
        ),
      };
    case 'http':
      return {
        ...fields,
        nativeHttp: yield* requiredInput(
          undefined,
          { path: '--native-http', question: 'Native HTTP URL: ' },
          context,
        ),
      };
    case 'background':
      return { ...fields, ...(yield* promptBackgroundFields(context)) };
    case 'jsonl':
      return { ...fields, ...(yield* promptJsonlFields(context)) };
    case 'stream':
      return { ...fields, ...(yield* promptStreamFields(context)) };
    case 'websocket':
      return { ...fields, ...(yield* promptWebSocketFields(context)) };
  }
});

export { promptTransportFields };
