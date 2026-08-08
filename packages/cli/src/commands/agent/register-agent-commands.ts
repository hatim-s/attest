import { COMMAND_REQUEST_SCHEMA_VERSION } from '@attest/contracts';
import { Command, Option } from 'commander';

import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import type { CliIo } from '../../run-cli.js';
import { renderCommandResult } from '../command-result.js';
import type { CliInteraction } from '../register-project-resource-commands.js';
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

type CommonOptions = {
  nonInteractive?: boolean;
  output?: 'human' | 'json';
  project?: string;
};

type MutationOptions = CommonOptions & {
  dryRun?: boolean;
  fromJson?: string;
  ifProjectHash?: string;
  yes?: boolean;
};

type AddOptions = MutationOptions & {
  argvJson?: string;
  env?: string[];
  headerEnv?: string[];
  name?: string;
  nativeCommand?: string;
  nativeHttp?: string;
  timeout?: string;
  trace?: boolean;
};

type ImportOptions = MutationOptions & { as?: string; name?: string; type?: string };
type RemoveOptions = MutationOptions & { detach?: boolean };
type TestOptions = CommonOptions & {
  fromJson?: string;
  input?: string;
  inputFile?: string;
  watch?: boolean;
};

const collect = (value: string, previous: string[] | undefined): string[] => [
  ...(previous ?? []),
  value,
];

const addCommonOptions = (command: Command): Command =>
  command
    .option('--project <dir>', 'explicit Attest project directory')
    .addOption(new Option('--output <format>', 'output format').choices(['human', 'json']))
    .option('--non-interactive', 'disable prompts and fail when required input is missing');

const addMutationOptions = (command: Command): Command =>
  addCommonOptions(command)
    .option('--dry-run', 'validate and show the semantic diff without writing')
    .option('--yes', 'accept confirmation prompts without inventing missing values')
    .option('--from-json <path|->', 'read one versioned command request from a file or stdin')
    .option('--if-project-hash <sha256>', 'fail if the project changed since it was read');

const outputFormat = (options: CommonOptions): 'human' | 'json' => options.output ?? 'human';

const isInteractive = (
  options: CommonOptions,
  interaction: CliInteraction,
  fromJson?: string,
): boolean =>
  options.nonInteractive !== true &&
  outputFormat(options) === 'human' &&
  fromJson === undefined &&
  !interaction.ci &&
  interaction.inputIsTTY &&
  interaction.outputIsTTY;

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
): void => {
  setCliCommandHelpMetadata(command, {
    examples,
    requestSchema: COMMAND_REQUEST_SCHEMA_VERSION,
    options: {
      output: { implies: ['non-interactive'] },
      'from-json': {
        conflicts: ['dry-run', 'if-project-hash', 'yes', ...Object.keys(extraConflicts)],
        implies: ['non-interactive'],
      },
      ...Object.fromEntries(
        Object.entries(extraConflicts).map(([name, conflicts]) => [
          name,
          { conflicts: ['from-json', ...conflicts] },
        ]),
      ),
    },
  });
};

/** Registers CLI2.6 agent authoring and native connection-test commands. */
const registerAgentCommands = (context: RegisterAgentCommandsOptions): void => {
  const agent = context.program.command('agent').description('Author and test native agents.');

  const add = addMutationOptions(
    agent
      .command('add')
      .description('Add one native agent resource.')
      .argument('[agent-id]', 'agent id'),
  )
    .option('--name <name>', 'agent display name; defaults to the id')
    .option('--native-command <command>', 'native CLI command tokenized into an argv array')
    .option('--argv-json <json>', 'unambiguous native CLI argv JSON array')
    .option('--native-http <url>', 'external native-envelope HTTP endpoint')
    .option('--env <target=source>', 'environment secret reference', collect)
    .option('--header-env <header=source>', 'HTTP header secret reference', collect)
    .option('--timeout <duration>', 'attempt timeout such as 500ms, 60s, or 2m')
    .option('--trace', 'declare trace support')
    .action(async (agentId: string | undefined, options: AddOptions) => {
      const result = await runAgentAddCommand({
        ...mutationArguments(options, context),
        agentId,
        argvJson: options.argvJson,
        env: options.env,
        headerEnv: options.headerEnv,
        interactive: isInteractive(options, context.interaction, options.fromJson),
        name: options.name,
        nativeCommand: options.nativeCommand,
        nativeHttp: options.nativeHttp,
        prompt: context.interaction.prompt,
        timeout: options.timeout,
        trace: options.trace,
      });
      context.io.output(renderCommandResult('agent.add', outputFormat(options), result));
    });
  registerMutationHelp(
    add,
    [
      'attest agent add support --argv-json \'["node","./src/agent.mjs"]\' --timeout 60s',
      'attest agent add support --native-http https://localhost:8787/invoke',
      'attest agent add --from-json ./agent-add.json --output json',
    ],
    {
      'agent-id': [],
      'argv-json': ['native-command', 'native-http'],
      env: ['native-http'],
      'header-env': ['argv-json', 'native-command'],
      name: [],
      'native-command': ['argv-json', 'native-http'],
      'native-http': ['argv-json', 'native-command'],
      timeout: [],
      trace: [],
    },
  );

  const importCommand = addMutationOptions(
    agent
      .command('import')
      .description('Import one canonical JSON native agent resource.')
      .argument('[path|-]', 'JSON resource path or stdin'),
  )
    .option('--as <agent-id>', 'imported agent id')
    .addOption(new Option('--type <type>', 'import type').choices(['json']))
    .option('--name <name>', 'override the imported display name')
    .action(async (source: string | undefined, options: ImportOptions) => {
      const result = await runAgentImportCommand({
        ...mutationArguments(options, context),
        agentId: options.as,
        interactive: isInteractive(options, context.interaction, options.fromJson),
        name: options.name,
        prompt: context.interaction.prompt,
        source,
        sourceType: options.type,
      });
      context.io.output(renderCommandResult('agent.import', outputFormat(options), result));
    });
  registerMutationHelp(
    importCommand,
    [
      'attest agent import ./agent.json --type json --as support',
      'attest agent import --from-json ./agent-import.json --output json',
    ],
    { as: [], name: [], path: [], type: [] },
  );

  const test = addCommonOptions(
    agent
      .command('test')
      .description('Probe one native agent contract.')
      .argument('[agent-id]', 'agent id'),
  )
    .option('--input <json>', 'test input as any JSON value')
    .option('--input-file <path|->', 'read test input JSON from a file or stdin')
    .option('--from-json <path|->', 'read one versioned agent.test request')
    .option('--watch', 'show human transport progress')
    .action(async (agentId: string | undefined, options: TestOptions) => {
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
          project: options.project,
          prompt: context.interaction.prompt,
          readStdin: context.interaction.readStdin,
          signal: controller.signal,
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
      'attest agent test --from-json ./agent-test.json --output json',
    ],
    requestSchema: COMMAND_REQUEST_SCHEMA_VERSION,
    options: {
      output: { implies: ['non-interactive'] },
      input: { conflicts: ['input-file', 'from-json'] },
      'input-file': { conflicts: ['input', 'from-json'] },
      'from-json': { conflicts: ['agent-id', 'input', 'input-file'], implies: ['non-interactive'] },
    },
  });

  const rename = addMutationOptions(
    agent
      .command('rename')
      .description('Rename an agent and every test reference atomically.')
      .argument('[agent-id]', 'current agent id')
      .argument('[new-id]', 'new agent id'),
  ).action(
    async (agentId: string | undefined, newId: string | undefined, options: MutationOptions) => {
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
  registerMutationHelp(rename, ['attest agent rename support support-v2'], {
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
    .action(async (agentId: string | undefined, options: RemoveOptions) => {
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
