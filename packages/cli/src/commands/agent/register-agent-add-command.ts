import { webSocketConnectionModeSchema, webSocketTransportSchema } from '@attest/contracts';
import {
  agentAddFlagConflicts,
  createAgentResource,
  runAgentAddCommand,
  type AgentAddFields,
} from '@attest/local/agent';
import { Option, type Command } from 'commander';

import { setMutationHelp } from '../../help/command-help.js';
import {
  addMutationOptions,
  collect,
  isInteractive,
  mutationRequestFields,
  outputFormat,
  type MutationCliOptions,
} from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';
import { readOrBuildRequest } from '../shared/command-request.js';
import { renderCommandResult } from '../shared/command-result.js';
import { requiredInput } from '../shared/required-input.js';
import { promptTransportFields } from './guided-agent-add.js';

/** Fields whose flag spelling does not camel-case to the local field name. */
type RenamedAddFields =
  | 'acknowledgementValues'
  | 'agentId'
  | 'cancellationGrace'
  | 'terminalValues'
  | 'webSocketLifecycle'
  | 'webSocketSubprotocol'
  | 'webSocketUrl';

type AddOptions = MutationCliOptions &
  Omit<AgentAddFields, RenamedAddFields> & {
    acknowledgementValue?: string[];
    cancelGrace?: string;
    subprotocol?: string;
    terminalValue?: string[];
    websocketLifecycle?: AgentAddFields['webSocketLifecycle'];
    websocketUrl?: string;
  };

const STREAM_FRAMINGS = ['sse', 'jsonl'] as const satisfies readonly NonNullable<
  AgentAddFields['streamFraming']
>[];
const BRIDGE_CONCURRENCY_MODES = ['serial', 'multiplexed'] as const satisfies readonly NonNullable<
  AgentAddFields['bridgeConcurrency']
>[];
const INCREMENTAL_OUTPUT_MODES = ['text', 'array'] as const satisfies readonly NonNullable<
  AgentAddFields['incrementalOutputMode']
>[];

/** Help-only hints: these WebSocket and stream flags take effect only with the flag they imply. */
const ADD_IMPLIES: Readonly<Record<string, string[]>> = {
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

/** Publishes local's transport conflict matrix and the help-only implications per flag. */
const addOptionHelp = () => {
  const conflicts = agentAddFlagConflicts();
  const names = new Set([...Object.keys(conflicts), ...Object.keys(ADD_IMPLIES)]);
  return Object.fromEntries(
    [...names].map((name) => [name, { conflicts: conflicts[name], implies: ADD_IMPLIES[name] }]),
  );
};

/** Maps parsed flags to local's field names; the spread keeps every flag that already matches. */
const agentAddFields = (agentId: string | undefined, options: AddOptions) => ({
  ...options,
  acknowledgementValues: options.acknowledgementValue,
  agentId,
  cancellationGrace: options.cancelGrace,
  terminalValues: options.terminalValue,
  webSocketLifecycle: options.websocketLifecycle,
  webSocketSubprotocol: options.subprotocol,
  webSocketUrl: options.websocketUrl,
});

/** Registers `agent add`; every transport's flags map onto one local agent resource. */
const registerAgentAddCommand = (agent: Command, context: CommandContext): void => {
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
    .addOption(new Option('--stream-framing <framing>', 'stream framing').choices(STREAM_FRAMINGS))
    .addOption(
      new Option('--bridge-concurrency <mode>', 'JSONL bridge concurrency').choices(
        BRIDGE_CONCURRENCY_MODES,
      ),
    )
    .addOption(
      new Option('--websocket-lifecycle <lifecycle>', 'WebSocket connection lifecycle').choices(
        webSocketTransportSchema.shape.lifecycle.options,
      ),
    )
    .addOption(
      new Option('--connection-mode <mode>', 'WebSocket request concurrency').choices(
        webSocketConnectionModeSchema.options,
      ),
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
      new Option('--incremental-output-mode <mode>', 'stream accumulation mode').choices(
        INCREMENTAL_OUTPUT_MODES,
      ),
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
    .action(async (agentId: string | undefined, options: AddOptions, leaf: Command) => {
      const fields = agentAddFields(agentId, options);
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const prompt = { interactive, prompt: context.interaction.prompt };
      const request = await readOrBuildRequest({
        command: 'agent.add',
        context,
        leaf,
        options,
        build: async () => {
          const id = await requiredInput(
            agentId,
            { path: '<agent-id>', question: 'Agent id: ' },
            prompt,
          );
          const guided = await promptTransportFields({ ...fields, agentId: id }, prompt);
          return {
            ...mutationRequestFields('agent.add', options),
            agent: createAgentResource(guided),
          };
        },
      });
      const result = await runAgentAddCommand({
        interactive,
        project: options.project,
        prompt: context.interaction.prompt,
        request,
        workingDirectory: context.workingDirectory,
      });
      context.io.output(renderCommandResult('agent.add', outputFormat(options), result));
    });

  setMutationHelp(add, {
    examples: [
      'attest agent add support --argv-json \'["node","./src/agent.mjs"]\' --timeout 60s',
      'attest agent add support --native-command "node ./src/agent.mjs" --sandbox-json \'{"kind":"vercel","files":[]}\'',
      'attest agent add support --native-http https://localhost:8787/invoke',
      'attest agent add support --background-command "node ./server.mjs" --readiness-http http://127.0.0.1:8787/ready --invoke-url http://127.0.0.1:8787/invoke',
      'attest agent add support --jsonl-command "node ./bridge.mjs" --bridge-concurrency multiplexed',
      'attest agent add support --stream-url https://example.com/events --stream-framing sse --terminal-pointer /type --terminal-value \'"result"\' --response-pointer /output',
      'attest agent add support --websocket-url wss://example.com/agent --header-env Authorization=AGENT_TOKEN --connection-mode multiplexed --response-pointer /output',
      'attest agent add --from-json ./agent-add.json --output json',
    ],
    options: addOptionHelp(),
  });
};

export { registerAgentAddCommand };
