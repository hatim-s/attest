import type { AgentAddFields } from '@attest/local/agent';

import { AttestCliError } from '../../errors/index.js';
import {
  commaSeparated,
  promptChoice,
  promptDefault,
  promptOptional,
  promptRequired,
  type AgentPromptContext,
} from './agent-prompts.js';

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

const readTransport = async (context: AgentPromptContext): Promise<GuidedTransport> => {
  const answer = (await context.prompt('Transport [cli/http/background/jsonl/stream/websocket]: '))
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
  throw new AttestCliError(
    'cli_usage',
    'Transport must be cli, http, background, jsonl, stream, or websocket.',
    { path: 'transport' },
  );
};

const promptBackgroundFields = async (
  context: AgentPromptContext,
): Promise<Partial<AgentAddFields>> => ({
  backgroundCommand: await promptRequired(
    undefined,
    'Background start command',
    '--background-command',
    context,
  ),
  readinessHttp: await promptRequired(undefined, 'Readiness HTTP URL', '--readiness-http', context),
  invokeUrl: await promptRequired(undefined, 'Invoke HTTP URL', '--invoke-url', context),
  responsePointer: await promptDefault(undefined, 'Result JSON Pointer', '/output', context),
  stopTimeout: await promptDefault(undefined, 'Stop timeout', '5s', context),
});

const promptJsonlFields = async (
  context: AgentPromptContext,
): Promise<Partial<AgentAddFields>> => ({
  jsonlCommand: await promptRequired(undefined, 'JSONL bridge command', '--jsonl-command', context),
  bridgeConcurrency: await promptChoice(
    'Bridge concurrency',
    ['serial', 'multiplexed'],
    'serial',
    '--bridge-concurrency',
    context,
  ),
  cancellationGrace: await promptDefault(undefined, 'Cancellation grace', '1s', context),
});

const promptStreamFields = async (
  context: AgentPromptContext,
): Promise<Partial<AgentAddFields>> => ({
  streamUrl: await promptRequired(undefined, 'Stream HTTP URL', '--stream-url', context),
  streamFraming: await promptChoice(
    'Stream framing',
    ['sse', 'jsonl'],
    'sse',
    '--stream-framing',
    context,
  ),
  terminalPointer: await promptDefault(undefined, 'Terminal JSON Pointer', '/type', context),
  terminalValues: [await promptDefault(undefined, 'Terminal JSON value', '"result"', context)],
  responsePointer: await promptDefault(undefined, 'Result JSON Pointer', '/output', context),
});

const promptWebSocketFields = async (
  context: AgentPromptContext,
): Promise<Partial<AgentAddFields>> => {
  const webSocketUrl = await promptRequired(undefined, 'WebSocket URL', '--websocket-url', context);
  const webSocketLifecycle = await promptChoice(
    'WebSocket lifecycle',
    ['per_run', 'per_case'],
    'per_run',
    '--websocket-lifecycle',
    context,
  );
  const connectionMode = await promptChoice(
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
      await context.prompt('Header environment references HEADER=ENV, comma-separated [none]: '),
    ),
    webSocketSubprotocol: await promptOptional(undefined, 'WebSocket subprotocol', context),
    requestTemplate: await promptDefault(
      undefined,
      'Request template JSON',
      '{"request_id":"{{request_id}}","request":"{{request}}"}',
      context,
    ),
    requestIdPointer: await promptDefault(
      undefined,
      'Request id JSON Pointer',
      '/request_id',
      context,
    ),
    acknowledgementPointer: await promptDefault(
      undefined,
      'Acknowledgement JSON Pointer',
      '/type',
      context,
    ),
    acknowledgementValues: [
      await promptDefault(undefined, 'Acknowledgement JSON value', '"acknowledgement"', context),
    ],
    responsePointer: await promptDefault(undefined, 'Result JSON Pointer', '/output', context),
    errorPointer: await promptDefault(undefined, 'Error JSON Pointer', '/error', context),
    tracePointer: await promptOptional(undefined, 'Trace JSON Pointer', context),
    openTimeout: await promptDefault(undefined, 'Open timeout', '10s', context),
    idleTimeout: await promptDefault(undefined, 'Message idle timeout', '30s', context),
    attemptTimeout: await promptDefault(undefined, 'Attempt timeout', '60s', context),
    pingInterval: await promptDefault(undefined, 'Ping interval', '15s', context),
    closeTimeout: await promptDefault(undefined, 'Close timeout', '5s', context),
  };
};

/**
 * Asks for the transport and its fields when no transport flag was passed. The answers replace
 * the matching flags; everything else the user passed is kept as-is.
 */
const promptTransportFields = async (
  fields: AgentAddFields,
  context: AgentPromptContext,
): Promise<AgentAddFields> => {
  if (!context.interactive || TRANSPORT_FLAGS.some((flag) => fields[flag] !== undefined)) {
    return fields;
  }
  switch (await readTransport(context)) {
    case 'cli':
      return {
        ...fields,
        nativeCommand: await promptRequired(
          undefined,
          'Native command',
          '--native-command',
          context,
        ),
      };
    case 'http':
      return {
        ...fields,
        nativeHttp: await promptRequired(undefined, 'Native HTTP URL', '--native-http', context),
      };
    case 'background':
      return { ...fields, ...(await promptBackgroundFields(context)) };
    case 'jsonl':
      return { ...fields, ...(await promptJsonlFields(context)) };
    case 'stream':
      return { ...fields, ...(await promptStreamFields(context)) };
    case 'websocket':
      return { ...fields, ...(await promptWebSocketFields(context)) };
  }
};

export { promptTransportFields };
