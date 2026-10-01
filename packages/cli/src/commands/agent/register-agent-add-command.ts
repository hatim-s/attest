import { runAgentAddCommand } from '@attest/local/agent';
import { Option, type Command } from 'commander';

import { renderCommandResult } from '../shared/command-result.js';
import {
  addMutationOptions,
  collectOption as collect,
  isInteractive,
  mergeCommonOptions,
  outputFormat,
  type MutationCliOptions,
} from '../shared/cli-options.js';
import {
  markAgentMutationHelp,
  mutationArguments,
  type RegisterAgentCommandsOptions,
} from './registration-support.js';

type AddOptions = MutationCliOptions & {
  acknowledgementPointer?: string;
  acknowledgementValues?: string[];
  argvJson?: string;
  attemptTimeout?: string;
  backgroundCommand?: string;
  bridgeConcurrency?: 'serial' | 'multiplexed';
  cancelGrace?: string;
  closeTimeout?: string;
  connectionMode?: 'serial' | 'multiplexed';
  cwd?: string;
  env?: string[];
  errorPointer?: string;
  eventName?: string;
  headerEnv?: string[];
  incrementalOutputMode?: 'text' | 'array';
  incrementalOutputPointer?: string;
  idleTimeout?: string;
  invokeUrl?: string;
  jsonlCommand?: string;
  name?: string;
  nativeCommand?: string;
  nativeHttp?: string;
  openTimeout?: string;
  pingInterval?: string;
  readinessHttp?: string;
  readinessStderr?: string;
  readinessTcp?: string;
  requestIdPointer?: string;
  requestTemplate?: string;
  responsePointer?: string;
  sandboxJson?: string;
  shutdownUrl?: string;
  stopTimeout?: string;
  streamFraming?: 'sse' | 'jsonl';
  streamUrl?: string;
  terminalPointer?: string;
  terminalValues?: string[];
  timeout?: string;
  trace?: boolean;
  tracePointer?: string;
  subprotocol?: string;
  websocketLifecycle?: 'per_case' | 'per_run';
  websocketUrl?: string;
};

const TRANSPORT_OPTIONS = [
  'argv-json',
  'native-command',
  'native-http',
  'background-command',
  'jsonl-command',
  'stream-url',
  'websocket-url',
] as const;

const conflictsOutside = (...supported: (typeof TRANSPORT_OPTIONS)[number][]): string[] =>
  TRANSPORT_OPTIONS.filter((name) => !supported.includes(name));

const ADD_CONFLICTS = {
  'agent-id': [],
  'argv-json': conflictsOutside('argv-json'),
  'acknowledgement-pointer': conflictsOutside('websocket-url'),
  'acknowledgement-value': conflictsOutside('websocket-url'),
  'attempt-timeout': conflictsOutside('websocket-url'),
  'background-command': [...conflictsOutside('background-command'), 'sandbox-json'],
  'bridge-concurrency': conflictsOutside('jsonl-command'),
  'cancel-grace': conflictsOutside('jsonl-command'),
  'close-timeout': conflictsOutside('websocket-url'),
  'connection-mode': conflictsOutside('websocket-url'),
  cwd: conflictsOutside('argv-json', 'native-command', 'background-command', 'jsonl-command'),
  env: conflictsOutside('argv-json', 'native-command', 'background-command', 'jsonl-command'),
  'error-pointer': conflictsOutside('background-command', 'stream-url', 'websocket-url'),
  'event-name': conflictsOutside('stream-url'),
  'header-env': conflictsOutside(
    'native-http',
    'background-command',
    'stream-url',
    'websocket-url',
  ),
  'incremental-output-mode': conflictsOutside('stream-url'),
  'incremental-output-pointer': conflictsOutside('stream-url'),
  'idle-timeout': conflictsOutside('websocket-url'),
  'invoke-url': conflictsOutside('background-command'),
  'jsonl-command': [...conflictsOutside('jsonl-command'), 'sandbox-json'],
  name: [],
  'native-command': conflictsOutside('native-command'),
  'native-http': [...conflictsOutside('native-http'), 'sandbox-json'],
  'open-timeout': conflictsOutside('websocket-url'),
  'ping-interval': conflictsOutside('websocket-url'),
  'readiness-http': [
    ...conflictsOutside('background-command'),
    'readiness-stderr',
    'readiness-tcp',
  ],
  'readiness-stderr': [
    ...conflictsOutside('background-command'),
    'readiness-http',
    'readiness-tcp',
  ],
  'readiness-tcp': [
    ...conflictsOutside('background-command'),
    'readiness-http',
    'readiness-stderr',
  ],
  'response-pointer': conflictsOutside('background-command', 'stream-url', 'websocket-url'),
  'sandbox-json': [
    'native-http',
    'background-command',
    'jsonl-command',
    'stream-url',
    'websocket-url',
  ],
  'request-id-pointer': conflictsOutside('websocket-url'),
  'request-template': conflictsOutside('websocket-url'),
  'shutdown-url': conflictsOutside('background-command'),
  'stop-timeout': conflictsOutside('background-command'),
  'stream-framing': conflictsOutside('stream-url'),
  'stream-url': [...conflictsOutside('stream-url'), 'sandbox-json'],
  subprotocol: conflictsOutside('websocket-url'),
  'terminal-pointer': conflictsOutside('stream-url'),
  'terminal-value': conflictsOutside('stream-url'),
  timeout: ['websocket-url'],
  trace: [],
  'trace-pointer': conflictsOutside('background-command', 'stream-url', 'websocket-url'),
  'websocket-lifecycle': conflictsOutside('websocket-url'),
  'websocket-url': [...conflictsOutside('websocket-url'), 'sandbox-json'],
};

const ADD_IMPLIES = {
  'acknowledgement-pointer': ['websocket-url'],
  'acknowledgement-value': ['websocket-url'],
  'attempt-timeout': ['websocket-url'],
  'close-timeout': ['websocket-url'],
  'connection-mode': ['websocket-url'],
  'idle-timeout': ['websocket-url'],
  'incremental-output-mode': ['incremental-output-pointer'],
  'open-timeout': ['websocket-url'],
  'ping-interval': ['websocket-url'],
  'request-id-pointer': ['websocket-url'],
  'request-template': ['websocket-url'],
  subprotocol: ['websocket-url'],
  'websocket-lifecycle': ['websocket-url'],
};

/** Registers the transport-rich `agent add` command without owning application behavior. */
const registerAgentAddCommand = (agent: Command, context: RegisterAgentCommandsOptions): void => {
  const add = addMutationOptions(
    agent
      .command('add')
      .description('Add one native, managed-process, streaming, or WebSocket agent resource.')
      .argument('[agent-id]', 'agent id'),
  )
    .option('--name <name>', 'agent display name; defaults to the id')
    .option('--native-command <command>', 'native CLI command tokenized into an argv array')
    .option('--argv-json <json>', 'unambiguous native CLI argv JSON array')
    .option('--sandbox-json <json>', 'Vercel sandbox JSON for a native CLI agent')
    .option('--native-http <url>', 'external native-envelope HTTP endpoint')
    .option('--background-command <command>', 'run-scoped background service command')
    .option('--jsonl-command <command>', 'run-scoped correlated JSONL bridge command')
    .option('--stream-url <url>', 'external SSE or JSONL stream endpoint')
    .option('--websocket-url <url>', 'plain ws:// or wss:// text-JSON endpoint')
    .addOption(new Option('--stream-framing <framing>', 'stream framing').choices(['sse', 'jsonl']))
    .addOption(
      new Option('--bridge-concurrency <mode>', 'JSONL bridge concurrency').choices([
        'serial',
        'multiplexed',
      ]),
    )
    .addOption(
      new Option('--websocket-lifecycle <lifecycle>', 'WebSocket connection lifecycle').choices([
        'per_case',
        'per_run',
      ]),
    )
    .addOption(
      new Option('--connection-mode <mode>', 'WebSocket request concurrency').choices([
        'serial',
        'multiplexed',
      ]),
    )
    .option('--subprotocol <token>', 'one plain WebSocket subprotocol token')
    .option('--request-template <json>', 'text-JSON request template with one {{request_id}} slot')
    .option('--request-id-pointer <pointer>', 'correlated response request-id JSON Pointer')
    .option('--acknowledgement-pointer <pointer>', 'acknowledgement JSON Pointer')
    .option(
      '--acknowledgement-value <json>',
      'accepted acknowledgement JSON value; repeatable',
      collect,
    )
    .option('--cwd <path>', 'project-relative process working directory')
    .option('--readiness-http <url>', 'background HTTP readiness endpoint')
    .option('--readiness-tcp <host:port>', 'background TCP readiness endpoint')
    .option('--readiness-stderr <regex>', 'background stderr readiness regex')
    .option('--invoke-url <url>', 'background invocation endpoint')
    .option('--shutdown-url <url>', 'optional background graceful shutdown endpoint')
    .option('--stop-timeout <duration>', 'background TERM/grace/KILL timeout')
    .option('--cancel-grace <duration>', 'JSONL in-band cancellation grace')
    .option('--response-pointer <pointer>', 'mapped terminal result JSON Pointer')
    .option('--error-pointer <pointer>', 'mapped error JSON Pointer')
    .option('--trace-pointer <pointer>', 'mapped trace JSON Pointer')
    .option('--event-name <name>', 'SSE application event filter')
    .option('--terminal-pointer <pointer>', 'stream terminal-state JSON Pointer')
    .option('--terminal-value <json>', 'stream terminal value as JSON; repeatable', collect)
    .option('--incremental-output-pointer <pointer>', 'stream incremental output JSON Pointer')
    .addOption(
      new Option('--incremental-output-mode <mode>', 'stream accumulation mode').choices([
        'text',
        'array',
      ]),
    )
    .option('--env <target=source>', 'environment secret reference', collect)
    .option('--header-env <header=source>', 'HTTP header secret reference', collect)
    .option('--timeout <duration>', 'attempt timeout such as 500ms, 60s, or 2m')
    .option('--open-timeout <duration>', 'WebSocket handshake timeout')
    .option('--idle-timeout <duration>', 'WebSocket message idle timeout')
    .option('--attempt-timeout <duration>', 'whole WebSocket attempt timeout')
    .option('--ping-interval <duration>', 'WebSocket ping interval')
    .option('--close-timeout <duration>', 'WebSocket graceful close timeout')
    .option('--trace', 'declare trace support')
    .action(async (agentId: string | undefined, raw: AddOptions, command: Command) => {
      const options = mergeCommonOptions(raw, command, context.program);
      const result = await runAgentAddCommand({
        ...mutationArguments(options, context),
        acknowledgementPointer: options.acknowledgementPointer,
        acknowledgementValues: options.acknowledgementValues,
        agentId,
        argvJson: options.argvJson,
        attemptTimeout: options.attemptTimeout,
        backgroundCommand: options.backgroundCommand,
        bridgeConcurrency: options.bridgeConcurrency,
        cancellationGrace: options.cancelGrace,
        closeTimeout: options.closeTimeout,
        connectionMode: options.connectionMode,
        cwd: options.cwd,
        env: options.env,
        errorPointer: options.errorPointer,
        eventName: options.eventName,
        headerEnv: options.headerEnv,
        incrementalOutputMode: options.incrementalOutputMode,
        incrementalOutputPointer: options.incrementalOutputPointer,
        idleTimeout: options.idleTimeout,
        invokeUrl: options.invokeUrl,
        jsonlCommand: options.jsonlCommand,
        interactive: isInteractive(options, context.interaction, options.fromJson),
        name: options.name,
        nativeCommand: options.nativeCommand,
        nativeHttp: options.nativeHttp,
        openTimeout: options.openTimeout,
        pingInterval: options.pingInterval,
        readinessHttp: options.readinessHttp,
        readinessStderr: options.readinessStderr,
        readinessTcp: options.readinessTcp,
        requestIdPointer: options.requestIdPointer,
        requestTemplate: options.requestTemplate,
        responsePointer: options.responsePointer,
        sandboxJson: options.sandboxJson,
        shutdownUrl: options.shutdownUrl,
        stopTimeout: options.stopTimeout,
        streamFraming: options.streamFraming,
        streamUrl: options.streamUrl,
        terminalPointer: options.terminalPointer,
        terminalValues: options.terminalValues,
        prompt: context.interaction.prompt,
        timeout: options.timeout,
        trace: options.trace,
        tracePointer: options.tracePointer,
        webSocketLifecycle: options.websocketLifecycle,
        webSocketSubprotocol: options.subprotocol,
        webSocketUrl: options.websocketUrl,
      });
      context.io.output(renderCommandResult('agent.add', outputFormat(options), result));
    });

  markAgentMutationHelp(
    add,
    [
      'attest agent add support --argv-json \'["node","./src/agent.mjs"]\' --timeout 60s',
      'attest agent add support --native-command "node ./src/agent.mjs" --sandbox-json \'{"kind":"vercel","files":[]}\'',
      'attest agent add support --native-http https://localhost:8787/invoke',
      'attest agent add support --background-command "node ./server.mjs" --readiness-http http://127.0.0.1:8787/ready --invoke-url http://127.0.0.1:8787/invoke',
      'attest agent add support --jsonl-command "node ./bridge.mjs" --bridge-concurrency multiplexed',
      'attest agent add support --stream-url https://example.com/events --stream-framing sse --terminal-pointer /type --terminal-value \'"result"\' --response-pointer /output',
      'attest agent add support --websocket-url wss://example.com/agent --header-env Authorization=AGENT_TOKEN --connection-mode multiplexed --response-pointer /output',
      'attest agent add --from-json ./agent-add.json --output json',
    ],
    ADD_CONFLICTS,
    ADD_IMPLIES,
  );
};

export { registerAgentAddCommand };
