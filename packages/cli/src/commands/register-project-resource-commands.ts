import { createInterface } from 'node:readline/promises';

import { COMMAND_REQUEST_SCHEMA_VERSION } from '@attest/contracts';
import { Argument, Command, Option } from 'commander';

import { AttestCliError } from '../errors.js';
import { setCliCommandHelpMetadata } from '../help/command-help.js';
import type { CliIo } from '../run-cli.js';
import { renderCommandResult } from './command-result.js';
import { registerAgentCommands } from './agent/register-agent-commands.js';
import { runListCommand, type ListResourceType } from './list/list-command.js';
import { runProjectInitCommand } from './project/project-init-command.js';
import {
  runProjectShowCommand,
  runProjectValidateCommand,
} from './project/project-inspection-command.js';
import { runSchemaListCommand, runSchemaPrintCommand } from './schema/schema-command.js';
import { runShowCommand, type ShowResourceType } from './show/show-command.js';

type CliInteraction = {
  ci: boolean;
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  prompt: (question: string, options?: { signal?: AbortSignal }) => Promise<string>;
  readStdin: () => Promise<string>;
};

type RegisterProjectResourceCommandsOptions = {
  interaction: CliInteraction;
  io: CliIo;
  program: Command;
  workingDirectory: string;
};

type CommonCommandOptions = {
  nonInteractive?: boolean;
  output?: 'human' | 'json';
  project?: string;
};

type ProjectInitCliOptions = CommonCommandOptions & {
  dryRun?: boolean;
  fromJson?: string;
  ifProjectHash?: string;
  name?: string;
  yes?: boolean;
};

/** Reads stdin to completion for one non-interactive command request. */
const readStdin = async (): Promise<string> => {
  let text = '';
  for await (const chunk of process.stdin as AsyncIterable<unknown>) {
    if (typeof chunk === 'string') {
      text += chunk;
    } else if (Buffer.isBuffer(chunk)) {
      text += chunk.toString('utf8');
    }
  }
  return text;
};

const createDefaultCliInteraction = (): CliInteraction => ({
  ci: process.env.CI === 'true',
  inputIsTTY: process.stdin.isTTY === true,
  outputIsTTY: process.stdout.isTTY === true,
  readStdin,
  prompt: async (question: string, options?: { signal?: AbortSignal }) => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      // Bind process cancellation to readline so its terminal listeners are closed in finally.
      return options?.signal === undefined
        ? await prompt.question(question)
        : await prompt.question(question, { signal: options.signal });
    } finally {
      prompt.close();
    }
  },
});

const addCommonOptions = (command: Command): Command =>
  command
    .option('--project <dir>', 'explicit Attest project directory')
    .addOption(new Option('--output <format>', 'output format').choices(['human', 'json']))
    .option('--non-interactive', 'disable prompts and fail when required input is missing');

const addOutputOption = (command: Command): Command =>
  command.addOption(new Option('--output <format>', 'output format').choices(['human', 'json']));

const addMutationOptions = (command: Command): Command =>
  addCommonOptions(command)
    .option('--dry-run', 'validate and show the semantic diff without writing')
    .option('--yes', 'accept confirmation prompts without inventing missing values')
    .option('--from-json <path|->', 'read one versioned command request from a file or stdin')
    .option('--if-project-hash <sha256>', 'fail if the project changed since it was read');

const mergedOptions = <T extends CommonCommandOptions>(
  local: T,
  command: Command,
  program: Command,
): T & Required<Pick<CommonCommandOptions, 'output'>> => {
  const root = program.opts<CommonCommandOptions>();
  for (const name of ['project', 'output', 'nonInteractive'] as const) {
    if (
      program.getOptionValueSource(name) === 'cli' &&
      command.getOptionValueSource(name) === 'cli'
    ) {
      const flag = name === 'nonInteractive' ? 'non-interactive' : name;
      throw new AttestCliError('cli_usage', `Common option --${flag} was provided twice.`, {
        path: `--${flag}`,
      });
    }
  }
  return {
    ...root,
    ...local,
    output: local.output ?? root.output ?? 'human',
  };
};

const isInteractive = (
  options: CommonCommandOptions,
  interaction: CliInteraction,
  fromJson?: string,
): boolean =>
  options.nonInteractive !== true &&
  options.output === 'human' &&
  fromJson === undefined &&
  !interaction.ci &&
  interaction.inputIsTTY &&
  interaction.outputIsTTY;

const registerProjectInit = (
  command: Command,
  aliasFor: string | undefined,
  context: RegisterProjectResourceCommandsOptions,
): void => {
  addMutationOptions(command)
    .argument('[directory]', 'target project directory')
    .option('--name <name>', 'project display name; defaults to the directory name')
    .action(
      async (directory: string | undefined, local: ProjectInitCliOptions, action: Command) => {
        const options = mergedOptions(local, action, context.program);
        const result = await runProjectInitCommand({
          directory,
          dryRun: options.dryRun,
          expectedProjectHash: options.ifProjectHash,
          fromJson: options.fromJson,
          interactive: isInteractive(options, context.interaction, options.fromJson),
          name: options.name,
          prompt: context.interaction.prompt,
          projectDirectory: options.project,
          readStdin: context.interaction.readStdin,
          workingDirectory: context.workingDirectory,
          yes: options.yes,
        });
        context.io.output(renderCommandResult('project.init', options.output, result));
      },
    );
  setCliCommandHelpMetadata(command, {
    ...(aliasFor === undefined ? {} : { aliasFor }),
    examples: [
      'attest project init --name support',
      'attest project init --from-json ./request.json --output json',
      'attest project init --dry-run --non-interactive --output json',
    ],
    requestSchema: COMMAND_REQUEST_SCHEMA_VERSION,
    options: {
      output: { implies: ['non-interactive'] },
      project: { conflicts: ['directory', 'from-json'] },
      name: { conflicts: ['from-json'] },
      'dry-run': { conflicts: ['from-json'] },
      yes: { conflicts: ['from-json'] },
      'if-project-hash': { conflicts: ['from-json'] },
      'from-json': {
        conflicts: ['directory', 'project', 'name', 'dry-run', 'yes', 'if-project-hash'],
        implies: ['non-interactive'],
      },
    },
  });
};

/** Registers only the ratified CLI2.5 project and resource inspection shell. */
const registerProjectResourceCommands = (context: RegisterProjectResourceCommandsOptions): void => {
  const project = context.program
    .command('project')
    .description('Initialize and inspect a v2 project.');
  const projectInit = new Command('init').description(
    'Initialize one canonical v2 Attest project.',
  );
  project.addCommand(projectInit);
  registerProjectInit(projectInit, undefined, context);

  const initAlias = new Command('init').description('Alias for `attest project init`.');
  context.program.addCommand(initAlias);
  registerProjectInit(initAlias, 'project.init', context);

  addCommonOptions(
    project.command('show').description('Show the discovered project manifest.'),
  ).action(async (local: CommonCommandOptions, action: Command) => {
    const options = mergedOptions(local, action, context.program);
    const result = await runProjectShowCommand({
      project: options.project,
      workingDirectory: context.workingDirectory,
    });
    context.io.output(renderCommandResult('project.show', options.output, result));
  });
  addCommonOptions(
    project.command('validate').description('Validate every authored project resource.'),
  ).action(async (local: CommonCommandOptions, action: Command) => {
    const options = mergedOptions(local, action, context.program);
    const result = await runProjectValidateCommand({
      project: options.project,
      workingDirectory: context.workingDirectory,
    });
    context.io.output(renderCommandResult('project.validate', options.output, result));
  });

  addCommonOptions(context.program.command('list').description('List project resources.'))
    .addArgument(
      new Argument('<resource>', 'resource collection').choices([
        'agents',
        'tests',
        'datasets',
        'metrics',
        'runs',
      ]),
    )
    .action(
      async (resourceType: ListResourceType, local: CommonCommandOptions, action: Command) => {
        const options = mergedOptions(local, action, context.program);
        const result = await runListCommand({
          project: options.project,
          resourceType,
          workingDirectory: context.workingDirectory,
        });
        context.io.output(renderCommandResult('list', options.output, result));
      },
    );

  addCommonOptions(context.program.command('show').description('Show one project resource.'))
    .addArgument(
      new Argument('<resource>', 'resource type').choices([
        'agent',
        'test',
        'dataset',
        'metric',
        'run',
      ]),
    )
    .argument('<id>', 'resource id')
    .action(
      async (
        resourceType: ShowResourceType,
        id: string,
        local: CommonCommandOptions,
        action: Command,
      ) => {
        const options = mergedOptions(local, action, context.program);
        const result = await runShowCommand({
          id,
          project: options.project,
          resourceType,
          workingDirectory: context.workingDirectory,
        });
        context.io.output(renderCommandResult('show', options.output, result));
      },
    );

  const schema = context.program
    .command('schema')
    .description('List or print generated contract JSON Schemas.');
  addOutputOption(
    schema.command('list').description('List registered contract schema ids.'),
  ).action((local: Pick<CommonCommandOptions, 'output'>, action: Command) => {
    const options = mergedOptions(local, action, context.program);
    context.io.output(renderCommandResult('schema.list', options.output, runSchemaListCommand()));
  });
  addOutputOption(
    schema
      .command('print')
      .description('Print one registered contract JSON Schema.')
      .argument('<schema-id>', 'schema id or generated filename'),
  ).action((schemaId: string, local: Pick<CommonCommandOptions, 'output'>, action: Command) => {
    const options = mergedOptions(local, action, context.program);
    context.io.output(
      renderCommandResult('schema.print', options.output, runSchemaPrintCommand(schemaId)),
    );
  });
  setCliCommandHelpMetadata(schema, {
    examples: [
      'attest schema list --output json',
      `attest schema print ${COMMAND_REQUEST_SCHEMA_VERSION} --output json`,
    ],
  });

  setCliCommandHelpMetadata(project, {
    examples: ['attest project init', 'attest project show --output json'],
  });
  registerAgentCommands(context);
  setCliCommandHelpMetadata(context.program, {
    examples: ['attest help --output json', 'attest project init', 'attest list agents'],
  });
};

export {
  createDefaultCliInteraction,
  registerProjectResourceCommands,
  type CliInteraction,
  type RegisterProjectResourceCommandsOptions,
};
