import { COMMAND_REQUEST_SCHEMA_ID } from '@attest/contracts';
import { Command, Option } from 'commander';

import { AttestCliError } from '../../errors/index.js';
import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import type { CliIo } from '../../run-cli.js';
import { renderCommandResult } from '../shared/command-result.js';
import {
  addCommonOptions,
  addMutationOptions,
  collectOption as collect,
  isInteractive,
  mergeCommonOptions,
  outputFormat,
  type CommonCliOptions as CommonOptions,
  type MutationCliOptions as MutationOptions,
} from '../shared/cli-options.js';
import type { CliInteraction } from '../shared/cli-interaction.js';
import {
  runAgentAddCommand,
  runAgentImportCommand,
  runAgentRemoveCommand,
  runAgentRenameCommand,
  runAgentTestCommand,
} from './agent-command.js';

type RegisterAgentCommandsOptions = {
  interaction: CliInteraction;
  io: CliIo;
  program: Command;
  workingDirectory: string;
};

type AddOptions = MutationOptions & {
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

type ImportOptions = MutationOptions & {
  as?: string;
  attemptTimeout?: string;
  bodyTimeout?: string;
  connectTimeout?: string;
  errorPointer?: string;
  firstByteTimeout?: string;
  headerEnv?: string[];
  idempotencyHeader?: string;
  mapBody?: string[];
  name?: string;
  pollFailure?: string[];
  pollJobIdPointer?: string;
  pollMaximumInterval?: string;
  pollMinimumInterval?: string;
  pollStatusPointer?: string;
  pollStatusUrlPointer?: string;
  pollStatusUrlTemplate?: string;
  pollSuccess?: string[];
  queryEnv?: string[];
  requestCapBytes?: string;
  responseCapBytes?: string;
  responsePointer?: string;
  retries?: string;
  retryDelay?: string;
  remoteJobIdPointer?: string;
  tracePointer?: string;
  type?: string;
};
type RemoveOptions = MutationOptions & { detach?: boolean };
type TestOptions = CommonOptions & {
  fromJson?: string;
  input?: string;
  inputFile?: string;
  record?: boolean;
  watch?: boolean;
};

const REPEATABLE_AGENT_OPTIONS = new Set([
  'acknowledgement-value',
  'env',
  'header-env',
  'map-body',
  'poll-failure',
  'poll-success',
  'query-env',
  'terminal-value',
]);

const mutationArguments = (options: MutationOptions, context: RegisterAgentCommandsOptions) => ({
  dryRun: options.dryRun,
  expectedProjectHash: options.ifProjectHash,
  fromJson: options.fromJson,
  project: options.project,
  readStdin: context.interaction.readStdin,
  workingDirectory: context.workingDirectory,
  yes: options.yes,
});

const registerMutationHelp = (
  command: Command,
  examples: string[],
  extraConflicts: Readonly<Record<string, string[]>>,
  extraImplies: Readonly<Record<string, string[]>> = {},
): void => {
  setCliCommandHelpMetadata(command, {
    examples,
    requestSchema: COMMAND_REQUEST_SCHEMA_ID,
    options: {
      output: { implies: ['non-interactive'] },
      'from-json': {
        conflicts: ['dry-run', 'if-project-hash', 'yes', ...Object.keys(extraConflicts)],
        implies: ['non-interactive'],
      },
      ...Object.fromEntries(
        Object.entries(extraConflicts).map(([name, conflicts]) => [
          name,
          {
            conflicts: ['from-json', ...conflicts],
            ...(extraImplies[name] === undefined ? {} : { implies: extraImplies[name] }),
            ...(REPEATABLE_AGENT_OPTIONS.has(name) ? { repeatable: true } : {}),
          },
        ]),
      ),
    },
  });
};

/** Registers agent authoring plus native, HTTP, streaming, and WebSocket UX commands. */
const registerAgentCommands = (context: RegisterAgentCommandsOptions): void => {
  const agent = context.program.command('agent').description('Author and test agent adapters.');

  const add = addMutationOptions(
    agent
      .command('add')
      .description('Add one native, managed-process, streaming, or WebSocket agent resource.')
      .argument('[agent-id]', 'agent id'),
  )
    .option('--name <name>', 'agent display name; defaults to the id')
    .option('--native-command <command>', 'native CLI command tokenized into an argv array')
    .option('--argv-json <json>', 'unambiguous native CLI argv JSON array')
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
    .action(async (agentId: string | undefined, options: AddOptions, command: Command) => {
      options = mergeCommonOptions(options, command, context.program);
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
  registerMutationHelp(
    add,
    [
      'attest agent add support --argv-json \'["node","./src/agent.mjs"]\' --timeout 60s',
      'attest agent add support --native-http https://localhost:8787/invoke',
      'attest agent add support --background-command "node ./server.mjs" --readiness-http http://127.0.0.1:8787/ready --invoke-url http://127.0.0.1:8787/invoke',
      'attest agent add support --jsonl-command "node ./bridge.mjs" --bridge-concurrency multiplexed',
      'attest agent add support --stream-url https://example.com/events --stream-framing sse --terminal-pointer /type --terminal-value \'"result"\' --response-pointer /output',
      'attest agent add support --websocket-url wss://example.com/agent --header-env Authorization=AGENT_TOKEN --connection-mode multiplexed --response-pointer /output',
      'attest agent add --from-json ./agent-add.json --output json',
    ],
    {
      'agent-id': [],
      'argv-json': [
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
        'websocket-url',
      ],
      'acknowledgement-pointer': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
      ],
      'acknowledgement-value': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
      ],
      'attempt-timeout': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
      ],
      'background-command': [
        'argv-json',
        'native-command',
        'native-http',
        'jsonl-command',
        'stream-url',
        'websocket-url',
      ],
      'bridge-concurrency': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'stream-url',
        'websocket-url',
      ],
      'cancel-grace': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'stream-url',
        'websocket-url',
      ],
      'close-timeout': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
      ],
      'connection-mode': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
      ],
      cwd: ['native-http', 'stream-url', 'websocket-url'],
      env: ['native-http', 'stream-url', 'websocket-url'],
      'error-pointer': ['argv-json', 'native-command', 'native-http', 'jsonl-command'],
      'event-name': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'websocket-url',
      ],
      'header-env': ['argv-json', 'native-command', 'jsonl-command'],
      'incremental-output-mode': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'websocket-url',
      ],
      'incremental-output-pointer': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'websocket-url',
      ],
      'idle-timeout': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
      ],
      'invoke-url': [
        'argv-json',
        'native-command',
        'native-http',
        'jsonl-command',
        'stream-url',
        'websocket-url',
      ],
      'jsonl-command': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'stream-url',
        'websocket-url',
      ],
      name: [],
      'native-command': [
        'argv-json',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
        'websocket-url',
      ],
      'native-http': [
        'argv-json',
        'native-command',
        'background-command',
        'jsonl-command',
        'stream-url',
        'websocket-url',
      ],
      'open-timeout': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
      ],
      'ping-interval': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
      ],
      'readiness-http': [
        'argv-json',
        'native-command',
        'native-http',
        'jsonl-command',
        'stream-url',
        'websocket-url',
        'readiness-stderr',
        'readiness-tcp',
      ],
      'readiness-stderr': [
        'argv-json',
        'native-command',
        'native-http',
        'jsonl-command',
        'stream-url',
        'websocket-url',
        'readiness-http',
        'readiness-tcp',
      ],
      'readiness-tcp': [
        'argv-json',
        'native-command',
        'native-http',
        'jsonl-command',
        'stream-url',
        'websocket-url',
        'readiness-http',
        'readiness-stderr',
      ],
      'response-pointer': ['argv-json', 'native-command', 'native-http', 'jsonl-command'],
      'request-id-pointer': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
      ],
      'request-template': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
      ],
      'shutdown-url': [
        'argv-json',
        'native-command',
        'native-http',
        'jsonl-command',
        'stream-url',
        'websocket-url',
      ],
      'stop-timeout': [
        'argv-json',
        'native-command',
        'native-http',
        'jsonl-command',
        'stream-url',
        'websocket-url',
      ],
      'stream-framing': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'websocket-url',
      ],
      'stream-url': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'websocket-url',
      ],
      subprotocol: [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
      ],
      'terminal-pointer': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'websocket-url',
      ],
      'terminal-value': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'websocket-url',
      ],
      timeout: ['websocket-url'],
      trace: [],
      'trace-pointer': ['argv-json', 'native-command', 'native-http', 'jsonl-command'],
      'websocket-lifecycle': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
      ],
      'websocket-url': [
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
      ],
    },
    {
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
    },
  );

  const importCommand = addMutationOptions(
    agent
      .command('import')
      .description('Import one canonical JSON resource or safely mapped cURL request.')
      .argument('[path|url|-]', 'JSON resource, local cURL file, URL, or stdin'),
  )
    .option('--as <agent-id>', 'imported agent id')
    .addOption(new Option('--type <type>', 'import type').choices(['json', 'curl']))
    .option('--name <name>', 'override the imported display name')
    .option(
      '--map-body <target=input>',
      'replace one JSON body pointer with an input pointer',
      collect,
    )
    .option(
      '--header-env <header=source>',
      'replace a captured header with an env reference',
      collect,
    )
    .option(
      '--query-env <query=source>',
      'replace a captured query value with an env reference',
      collect,
    )
    .option('--response-pointer <pointer>', 'foreign response result JSON Pointer')
    .option('--error-pointer <pointer>', 'foreign response error JSON Pointer')
    .option('--trace-pointer <pointer>', 'foreign response trace JSON Pointer')
    .option('--remote-job-id-pointer <pointer>', 'foreign response job-id evidence pointer')
    .option('--poll-job-id-pointer <pointer>', 'submission job-id JSON Pointer')
    .option('--poll-status-url-pointer <pointer>', 'submission status-URL JSON Pointer')
    .option('--poll-status-url-template <url>', 'same-origin status URL with {{job_id}}')
    .option('--poll-status-pointer <pointer>', 'polled status JSON Pointer')
    .option('--poll-success <json>', 'terminal success JSON value', collect)
    .option('--poll-failure <json>', 'terminal failure JSON value', collect)
    .option('--poll-minimum-interval <duration>', 'minimum polling interval')
    .option('--poll-maximum-interval <duration>', 'maximum polling interval')
    .option('--idempotency-header <name>', 'stable submission idempotency header')
    .option('--connect-timeout <duration>', 'DNS/connect timeout')
    .option('--first-byte-timeout <duration>', 'response-header timeout')
    .option('--body-timeout <duration>', 'response body idle timeout')
    .option('--attempt-timeout <duration>', 'whole direct or polling attempt timeout')
    .option('--request-cap-bytes <bytes>', 'maximum materialized request bytes')
    .option('--response-cap-bytes <bytes>', 'maximum response body bytes')
    .option('--retries <count>', 'safe transport retry count')
    .option('--retry-delay <duration>', 'fixed transport retry delay')
    .action(async (source: string | undefined, options: ImportOptions, command: Command) => {
      options = mergeCommonOptions(options, command, context.program);
      const result = await runAgentImportCommand({
        ...mutationArguments(options, context),
        agentId: options.as,
        attemptTimeout: options.attemptTimeout,
        bodyTimeout: options.bodyTimeout,
        connectTimeout: options.connectTimeout,
        errorPointer: options.errorPointer,
        firstByteTimeout: options.firstByteTimeout,
        headerEnv: options.headerEnv,
        idempotencyHeader: options.idempotencyHeader,
        interactive: isInteractive(options, context.interaction, options.fromJson),
        mapBody: options.mapBody,
        name: options.name,
        pollFailure: options.pollFailure,
        pollJobIdPointer: options.pollJobIdPointer,
        pollMaximumInterval: options.pollMaximumInterval,
        pollMinimumInterval: options.pollMinimumInterval,
        pollStatusPointer: options.pollStatusPointer,
        pollStatusUrlPointer: options.pollStatusUrlPointer,
        pollStatusUrlTemplate: options.pollStatusUrlTemplate,
        pollSuccess: options.pollSuccess,
        prompt: context.interaction.prompt,
        queryEnv: options.queryEnv,
        requestCapBytes: options.requestCapBytes,
        responseCapBytes: options.responseCapBytes,
        responsePointer: options.responsePointer,
        retries: options.retries,
        retryDelay: options.retryDelay,
        remoteJobIdPointer: options.remoteJobIdPointer,
        source,
        sourceType: options.type,
        tracePointer: options.tracePointer,
      });
      context.io.output(renderCommandResult('agent.import', outputFormat(options), result));
    });
  registerMutationHelp(
    importCommand,
    [
      'attest agent import ./agent.json --type json --as support',
      'attest agent import request.curl --type curl --as support --map-body /prompt=/question --response-pointer /answer',
      'attest agent import --from-json ./agent-import.json --output json',
    ],
    {
      as: [],
      'attempt-timeout': [],
      'body-timeout': [],
      'connect-timeout': [],
      'error-pointer': [],
      'first-byte-timeout': [],
      'header-env': [],
      'idempotency-header': [],
      'map-body': [],
      name: [],
      path: [],
      'poll-failure': [],
      'poll-job-id-pointer': [],
      'poll-maximum-interval': [],
      'poll-minimum-interval': [],
      'poll-status-pointer': [],
      'poll-status-url-pointer': ['poll-status-url-template'],
      'poll-status-url-template': ['poll-status-url-pointer'],
      'poll-success': [],
      'query-env': [],
      'request-cap-bytes': [],
      'response-cap-bytes': [],
      'response-pointer': [],
      retries: [],
      'retry-delay': [],
      'remote-job-id-pointer': [],
      'trace-pointer': [],
      type: [],
    },
  );

  const test = addCommonOptions(
    agent
      .command('test')
      .description(
        'Probe one native, managed-process, HTTP, polling, streaming, or WebSocket agent contract.',
      )
      .argument('[agent-id]', 'agent id'),
  )
    .option('--input <json>', 'test input as any JSON value')
    .option('--input-file <path|->', 'read test input JSON from a file or stdin')
    .option('--from-json <path|->', 'read one agent.test request')
    .option('--record', 'persist this probe as an eval run')
    .option('--watch', 'show human transport progress')
    .action(async (agentId: string | undefined, options: TestOptions, command: Command) => {
      options = mergeCommonOptions(options, command, context.program);
      if (options.watch === true && outputFormat(options) !== 'human') {
        throw new AttestCliError('cli_usage', '--watch requires human output.', {
          path: '--watch',
        });
      }
      if (
        options.watch === true &&
        !isInteractive(options, context.interaction, options.fromJson)
      ) {
        throw new AttestCliError('cli_usage', '--watch requires an interactive human terminal.', {
          path: '--watch',
        });
      }
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try {
        const result = await runAgentTestCommand({
          agentId,
          fromJson: options.fromJson,
          input: options.input,
          inputFile: options.inputFile,
          interactive: isInteractive(options, context.interaction, options.fromJson),
          onProgress: (message) => context.io.error(message),
          project: options.project,
          prompt: context.interaction.prompt,
          readStdin: context.interaction.readStdin,
          record: options.record,
          signal: controller.signal,
          watch: options.watch,
          workingDirectory: context.workingDirectory,
        });
        context.io.output(renderCommandResult('agent.test', outputFormat(options), result));
      } finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
      }
    });
  setCliCommandHelpMetadata(test, {
    examples: [
      'attest agent test support --input \'{"question":"ping"}\' --output json',
      'attest agent test support --watch',
      'attest agent test support --record --output json',
      'attest agent test --from-json ./agent-test.json --output json',
    ],
    requestSchema: COMMAND_REQUEST_SCHEMA_ID,
    options: {
      output: { implies: ['non-interactive'] },
      input: { conflicts: ['input-file', 'from-json'] },
      'input-file': { conflicts: ['input', 'from-json'] },
      'from-json': {
        conflicts: ['agent-id', 'input', 'input-file', 'record'],
        implies: ['non-interactive'],
      },
      record: { conflicts: ['from-json'] },
      watch: { conflicts: ['output', 'non-interactive'] },
    },
  });

  const rename = addMutationOptions(
    agent
      .command('rename')
      .description('Rename an agent and every test reference atomically.')
      .argument('[agent-id]', 'current agent id')
      .argument('[new-id]', 'new agent id'),
  ).action(
    async (
      agentId: string | undefined,
      newId: string | undefined,
      options: MutationOptions,
      command: Command,
    ) => {
      options = mergeCommonOptions(options, command, context.program);
      const result = await runAgentRenameCommand({
        ...mutationArguments(options, context),
        agentId,
        interactive: isInteractive(options, context.interaction, options.fromJson),
        newId,
        prompt: context.interaction.prompt,
      });
      context.io.output(renderCommandResult('agent.rename', outputFormat(options), result));
    },
  );
  registerMutationHelp(rename, ['attest agent rename support support-renamed'], {
    'agent-id': [],
    'new-id': [],
  });

  const remove = addMutationOptions(
    agent
      .command('remove')
      .description('Remove an agent resource.')
      .argument('[agent-id]', 'agent id'),
  )
    .option('--detach', 'also remove tests that require this agent')
    .action(async (agentId: string | undefined, options: RemoveOptions, command: Command) => {
      options = mergeCommonOptions(options, command, context.program);
      const result = await runAgentRemoveCommand({
        ...mutationArguments(options, context),
        agentId,
        detach: options.detach,
        interactive: isInteractive(options, context.interaction, options.fromJson),
        prompt: context.interaction.prompt,
      });
      context.io.output(renderCommandResult('agent.remove', outputFormat(options), result));
    });
  registerMutationHelp(remove, ['attest agent remove support --dry-run'], {
    'agent-id': [],
    detach: [],
  });

  setCliCommandHelpMetadata(agent, {
    examples: ['attest agent add', 'attest agent test support --output json'],
  });
};

export { registerAgentCommands, type RegisterAgentCommandsOptions };
