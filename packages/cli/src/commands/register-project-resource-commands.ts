import { COMMAND_REQUEST_SCHEMA_ID } from '@attest/contracts';
import {
  runListCommand,
  runProjectInitCommand,
  runProjectShowCommand,
  runProjectValidateCommand,
  runShowCommand,
  type ListResourceType,
  type ShowResourceType,
} from '@attest/local/project';
import { Argument, type Command } from 'commander';

import { setCliCommandHelpMetadata } from '../help/command-help.js';
import { registerAgentCommands } from './agent/register-agent-commands.js';
import {
  renderSchemaList,
  renderSchemaPrint,
  runSchemaListCommand,
  runSchemaPrintCommand,
} from './schema/schema-command.js';
import {
  addCommonOptions,
  addMutationOptions,
  commonOption,
  isInteractive,
  outputFormat,
  outputOption,
  type CommonCliOptions,
  type MutationCliOptions,
} from './shared/cli-options.js';
import type { CommandContext } from './shared/command-context.js';
import { renderCommandResult, renderResult } from './shared/command-result.js';

type ProjectInitCliOptions = MutationCliOptions & {
  name?: string;
};

const registerProjectInit = (
  command: Command,
  aliasFor: string | undefined,
  context: CommandContext,
): void => {
  addMutationOptions(command)
    .argument('[directory]', 'target project directory')
    .option('--name <name>', 'project display name; defaults to the directory name')
    .action(async (directory: string | undefined, options: ProjectInitCliOptions) => {
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
      context.io.output(renderCommandResult('project.init', outputFormat(options), result));
    });
  setCliCommandHelpMetadata(command, {
    aliasFor,
    examples: [
      'attest project init --name support',
      'attest project init --from-json ./request.json --output json',
      'attest project init --dry-run --non-interactive --output json',
    ],
    requestSchema: COMMAND_REQUEST_SCHEMA_ID,
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

/** Registers project init, show, and validate, the list and show readers, and schema output. */
const registerProjectResourceCommands = (context: CommandContext): void => {
  const project = context.program
    .command('project')
    .description('Initialize and inspect a project.');
  registerProjectInit(
    project.command('init').description('Initialize one canonical Attest project.'),
    undefined,
    context,
  );
  // Commander aliases only name siblings, so the top-level `init` is its own registration.
  registerProjectInit(
    context.program.command('init').description('Alias for `attest project init`.'),
    'project.init',
    context,
  );

  const inspections = [
    {
      name: 'show',
      description: 'Show the discovered project manifest.',
      run: runProjectShowCommand,
    },
    {
      name: 'validate',
      description: 'Validate every authored project resource.',
      run: runProjectValidateCommand,
    },
  ] as const;
  for (const { description, name, run } of inspections) {
    addCommonOptions(project.command(name).description(description)).action(
      async (options: CommonCliOptions) => {
        const result = await run({
          project: options.project,
          workingDirectory: context.workingDirectory,
        });
        context.io.output(renderCommandResult(`project.${name}`, outputFormat(options), result));
      },
    );
  }
  setCliCommandHelpMetadata(project, {
    examples: ['attest project init', 'attest project show --output json'],
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
    .action(async (resourceType: ListResourceType, options: CommonCliOptions) => {
      const result = await runListCommand({
        project: options.project,
        resourceType,
        workingDirectory: context.workingDirectory,
      });
      context.io.output(renderCommandResult('list', outputFormat(options), result));
    });

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
    .action(async (resourceType: ShowResourceType, id: string, options: CommonCliOptions) => {
      const result = await runShowCommand({
        id,
        project: options.project,
        resourceType,
        workingDirectory: context.workingDirectory,
      });
      context.io.output(renderCommandResult('show', outputFormat(options), result));
    });

  const schema = context.program
    .command('schema')
    .description('List or print generated contract JSON Schemas.');
  schema
    .command('list')
    .description('List registered contract schema ids.')
    .addOption(commonOption(outputOption()))
    .action((options: CommonCliOptions) => {
      context.io.output(
        renderResult(
          'schema.list',
          outputFormat(options),
          runSchemaListCommand(),
          renderSchemaList,
        ),
      );
    });
  schema
    .command('print')
    .description('Print one registered contract JSON Schema.')
    .argument('<schema-id>', 'schema id or generated filename')
    .addOption(commonOption(outputOption()))
    .action((schemaId: string, options: CommonCliOptions) => {
      context.io.output(
        renderResult(
          'schema.print',
          outputFormat(options),
          runSchemaPrintCommand(schemaId),
          renderSchemaPrint,
        ),
      );
    });
  setCliCommandHelpMetadata(schema, {
    examples: [
      'attest schema list --output json',
      `attest schema print ${COMMAND_REQUEST_SCHEMA_ID} --output json`,
    ],
  });

  registerAgentCommands(context);
};

export { registerProjectResourceCommands };
