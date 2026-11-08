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

const readTransport = Effect.fn('readTransport')(function* (context: PromptContext) {
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
) {
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
    responsePointer: yield* promptDefault(context, {
      question: 'Result JSON Pointer',
      fallback: '/output',
    }),
    stopTimeout: yield* promptDefault(context, { question: 'Stop timeout', fallback: '5s' }),
  };
});

const promptJsonlFields = Effect.fn('promptJsonlFields')(function* (context: PromptContext) {
  return {
    jsonlCommand: yield* requiredInput(
      undefined,
      { path: '--jsonl-command', question: 'JSONL bridge command: ' },
      context,
    ),
    bridgeConcurrency: yield* promptChoice(context, {
      question: 'Bridge concurrency',
      choices: ['serial', 'multiplexed'],
      fallback: 'serial',
      path: '--bridge-concurrency',
    }),
    cancellationGrace: yield* promptDefault(context, {
      question: 'Cancellation grace',
      fallback: '1s',
    }),
  };
});

const promptStreamFields = Effect.fn('promptStreamFields')(function* (context: PromptContext) {
  return {
    streamUrl: yield* requiredInput(
      undefined,
      { path: '--stream-url', question: 'Stream HTTP URL: ' },
      context,
    ),
    streamFraming: yield* promptChoice(context, {
      question: 'Stream framing',
      choices: ['sse', 'jsonl'],
      fallback: 'sse',
      path: '--stream-framing',
    }),
    terminalPointer: yield* promptDefault(context, {
      question: 'Terminal JSON Pointer',
      fallback: '/type',
    }),
    terminalValues: [
      yield* promptDefault(context, { question: 'Terminal JSON value', fallback: '"result"' }),
    ],
    responsePointer: yield* promptDefault(context, {
      question: 'Result JSON Pointer',
      fallback: '/output',
    }),
  };
});

const promptWebSocketFields = Effect.fn('promptWebSocketFields')(function* (
  context: PromptContext,
) {
  const webSocketUrl = yield* requiredInput(
    undefined,
    { path: '--websocket-url', question: 'WebSocket URL: ' },
    context,
  );

  const webSocketLifecycle = yield* promptChoice(context, {
    question: 'WebSocket lifecycle',
    choices: ['per_run', 'per_case'],
    fallback: 'per_run',
    path: '--websocket-lifecycle',
  });

  const connectionMode = yield* promptChoice(context, {
    question: 'Connection mode',
    choices: ['serial', 'multiplexed'],
    fallback: webSocketLifecycle === 'per_case' ? 'serial' : 'multiplexed',
    path: '--connection-mode',
  });

  return {
    webSocketUrl,
    webSocketLifecycle,
    connectionMode,
    headerEnv: commaSeparated(
      yield* ask(context, 'Header environment references HEADER=ENV, comma-separated [none]: '),
    ),
    webSocketSubprotocol: yield* promptOptional(undefined, 'WebSocket subprotocol', context),
    requestTemplate: yield* promptDefault(context, {
      question: 'Request template JSON',
      fallback: '{"request_id":"{{request_id}}","request":"{{request}}"}',
    }),
    requestIdPointer: yield* promptDefault(context, {
      question: 'Request id JSON Pointer',
      fallback: '/request_id',
    }),
    acknowledgementPointer: yield* promptDefault(context, {
      question: 'Acknowledgement JSON Pointer',
      fallback: '/type',
    }),
    acknowledgementValues: [
      yield* promptDefault(context, {
        question: 'Acknowledgement JSON value',
        fallback: '"acknowledgement"',
      }),
    ],
    responsePointer: yield* promptDefault(context, {
      question: 'Result JSON Pointer',
      fallback: '/output',
    }),
    errorPointer: yield* promptDefault(context, {
      question: 'Error JSON Pointer',
      fallback: '/error',
    }),
    tracePointer: yield* promptOptional(undefined, 'Trace JSON Pointer', context),
    openTimeout: yield* promptDefault(context, { question: 'Open timeout', fallback: '10s' }),
    idleTimeout: yield* promptDefault(context, {
      question: 'Message idle timeout',
      fallback: '30s',
    }),
    attemptTimeout: yield* promptDefault(context, { question: 'Attempt timeout', fallback: '60s' }),
    pingInterval: yield* promptDefault(context, { question: 'Ping interval', fallback: '15s' }),
    closeTimeout: yield* promptDefault(context, { question: 'Close timeout', fallback: '5s' }),
  };
});

/**
 * Asks for the transport and its fields when no transport flag was passed. The answers replace
 * the matching flags; everything else the user passed is kept as-is.
 */
const promptTransportFields = Effect.fn('promptTransportFields')(function* (
  fields: AgentAddFields,
  context: PromptContext,
) {
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
