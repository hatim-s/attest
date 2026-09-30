import {
  COMMAND_REQUEST_SCHEMA_ID,
  CLI_HELP_SCHEMA_ID,
  cliHelpArgumentSchema,
  cliHelpOptionSchema,
  cliHelpSchema,
  type CliHelp,
  type JsonValue,
  type MetricPreset,
} from '@attest/contracts';
import { type Argument, type Command, type Option } from 'commander';

import { authoredFieldNames, collect } from '../commands/shared/cli-options.js';
import { AttestCliError } from '../errors/cli-error.js';

type CliOptionHelpMetadata = {
  conflicts?: readonly string[];
  default?: JsonValue;
  implies?: readonly string[];
};

type CliCommandHelpMetadata = {
  aliasFor?: string;
  examples?: readonly string[];
  constraints?: readonly string[];
  presets?: readonly MetricPreset[];
  requestSchema?: string;
  options?: Readonly<Record<string, CliOptionHelpMetadata>>;
};

/** A help node before `cliHelpSchema` validates the whole tree and copies the frozen presets. */
type CommandHelpDraft = Omit<CliHelp['command'], 'presets' | 'subcommands'> & {
  presets?: readonly MetricPreset[];
  subcommands: CommandHelpDraft[];
};

const metadataByCommand = new WeakMap<Command, CliCommandHelpMetadata>();

/** Associates structured metadata that Commander does not retain on public fields. */
const setCliCommandHelpMetadata = (command: Command, metadata: CliCommandHelpMetadata): void => {
  metadataByCommand.set(command, metadata);
};

type MutationHelp = {
  constraints?: readonly string[];
  examples: readonly string[];
  /** Extra metadata for authored options; `from-json` is always added to their conflicts. */
  options?: Readonly<Record<string, CliOptionHelpMetadata>>;
  presets?: readonly MetricPreset[];
};

/**
 * Records help for a command that accepts either authored flags and arguments or one complete
 * `--from-json` request. The authored fields are read from the registered command, so call this
 * after every option is added.
 */
const setMutationHelp = (command: Command, help: MutationHelp): void => {
  const fields = authoredFieldNames(command);
  setCliCommandHelpMetadata(command, {
    constraints: help.constraints,
    examples: help.examples,
    presets: help.presets,
    requestSchema: COMMAND_REQUEST_SCHEMA_ID,
    options: {
      output: { implies: ['non-interactive'] },
      'from-json': {
        conflicts: ['dry-run', 'if-project-hash', 'yes', ...fields],
        implies: ['non-interactive'],
      },
      ...Object.fromEntries(
        fields.map((field) => {
          const extra = help.options?.[field];
          return [field, { ...extra, conflicts: ['from-json', ...(extra?.conflicts ?? [])] }];
        }),
      ),
    },
  });
};

const argumentUsage = (argument: Argument): string => {
  const suffix = argument.variadic ? '...' : '';
  return argument.required ? `<${argument.name()}${suffix}>` : `[${argument.name()}${suffix}]`;
};

const toArgumentHelp = (argument: Argument): CliHelp['command']['arguments'][number] => ({
  name: argument.name(),
  usage: argumentUsage(argument),
  description: argument.description,
  required: argument.required,
  variadic: argument.variadic,
  choices: argument.argChoices ?? [],
  default: cliHelpArgumentSchema.shape.default.parse(argument.defaultValue ?? null),
});

const optionValueName = (option: Option): string | null => {
  if (!option.required && !option.optional) return null;
  // Commander keeps the value placeholder only in the flags, as the last word: `--output <format>`.
  const placeholder = option.flags.split(' ').at(-1) ?? '';
  return placeholder.slice(1, -1);
};

const toOptionHelp = (
  option: Option,
  metadata: CliOptionHelpMetadata | undefined,
): CliHelp['command']['options'][number] => ({
  name: option.name(),
  flags: option.flags,
  description: option.description,
  value_name: optionValueName(option),
  required: option.mandatory,
  repeatable: option.variadic || option.parseArg === collect,
  choices: option.argChoices ?? [],
  default:
    metadata?.default ?? cliHelpOptionSchema.shape.default.parse(option.defaultValue ?? null),
  conflicts: [...(metadata?.conflicts ?? [])],
  implies: [...(metadata?.implies ?? [])],
});

const getCommandPath = (command: Command): string[] => {
  const path: string[] = [];
  let current: Command | null = command;
  while (current !== null && current.parent !== null) {
    path.unshift(current.name());
    current = current.parent;
  }
  return path;
};

const findCommand = (program: Command, path: readonly string[]): Command => {
  let current = program;
  for (const segment of path) {
    const child = current.commands.find(
      (candidate) => candidate.name() === segment || candidate.aliases().includes(segment),
    );
    if (child === undefined) {
      throw new AttestCliError('cli_usage', `Unknown help path: ${path.join(' ')}.`, {
        path: path.join('.'),
        hint: 'Run `attest help --output json` to inspect registered command paths.',
      });
    }
    current = child;
  }
  return current;
};

const toCommandHelp = (command: Command): CommandHelpDraft => {
  const metadata = metadataByCommand.get(command);
  const path = getCommandPath(command);
  const commandPrefix = ['attest', ...path].join(' ');
  const usageSuffix = command.usage();

  return {
    path,
    name: command.name(),
    summary: command.description(),
    usage: `${commandPrefix}${usageSuffix.length === 0 ? '' : ` ${usageSuffix}`}`,
    arguments: command.registeredArguments.map(toArgumentHelp),
    options: command.options.map((option) =>
      toOptionHelp(option, metadata?.options?.[option.name()]),
    ),
    subcommands: [...command.commands]
      .sort((left, right) => left.name().localeCompare(right.name()))
      .map(toCommandHelp),
    aliases: command.aliases(),
    alias_for: metadata?.aliasFor ?? null,
    request_schema: metadata?.requestSchema ?? null,
    examples: [...(metadata?.examples ?? [])],
    constraints: [...(metadata?.constraints ?? [])],
    ...(metadata?.presets === undefined ? {} : { presets: metadata.presets }),
  };
};

/** Names a command in JSON results by its dotted path; an alias reports the command it runs. */
const resultCommandName = (command: Command): string =>
  metadataByCommand.get(command)?.aliasFor ?? (getCommandPath(command).join('.') || 'cli');

/** Builds a validated machine-readable tree for the selected registered command path. */
const createCliHelp = (program: Command, path: readonly string[] = []): CliHelp =>
  cliHelpSchema.parse({
    schema: CLI_HELP_SCHEMA_ID,
    command: toCommandHelp(findCommand(program, path)),
  });

/** Renders the same help contract as deterministic human-readable terminal text. */
const renderCliHelp = (help: CliHelp): string => {
  const { command } = help;
  const sections = [command.summary, `Usage: ${command.usage}`];

  if (command.arguments.length > 0) {
    sections.push(
      `Arguments:\n${command.arguments
        .map((argument) => `  ${argument.usage.padEnd(20)} ${argument.description}`.trimEnd())
        .join('\n')}`,
    );
  }
  if (command.options.length > 0) {
    sections.push(
      `Options:\n${command.options
        .map((option) => `  ${option.flags.padEnd(24)} ${option.description}`.trimEnd())
        .join('\n')}`,
    );
  }
  if (command.subcommands.length > 0) {
    sections.push(
      `Commands:\n${command.subcommands
        .map((subcommand) => `  ${subcommand.name.padEnd(20)} ${subcommand.summary}`.trimEnd())
        .join('\n')}`,
    );
  }
  if (command.examples.length > 0) {
    sections.push(`Examples:\n${command.examples.map((example) => `  ${example}`).join('\n')}`);
  }
  if (command.presets !== undefined) {
    sections.push(
      `Presets (${command.presets[0]?.schema ?? 'unknown'}):\n${command.presets
        .map((preset, index) => {
          const required =
            preset.required_inputs.length === 0 ? 'none' : preset.required_inputs.join(', ');
          const configurable =
            preset.configurable_fields.length === 0
              ? 'none'
              : preset.configurable_fields.join(', ');
          return `  ${preset.id}${index === 0 ? ' (default)' : ''}\n    ${preset.description}\n    required: ${required}; configurable: ${configurable}`;
        })
        .join('\n')}`,
    );
  }

  return sections.filter((section) => section.length > 0).join('\n\n');
};

export {
  createCliHelp,
  renderCliHelp,
  resultCommandName,
  setCliCommandHelpMetadata,
  setMutationHelp,
};
