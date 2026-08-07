import {
  CLI_HELP_SCHEMA_VERSION,
  cliHelpSchema,
  type CliHelp,
  type JsonValue,
} from '@attest/contracts';
import { type Argument, type Command, type Option } from 'commander';

import { AttestCliError } from '../errors.js';

type CliOptionHelpMetadata = {
  conflicts?: readonly string[];
  implies?: readonly string[];
};

type CliCommandHelpMetadata = {
  aliasFor?: string;
  deprecated?: string;
  examples?: readonly string[];
  requestSchema?: string;
  options?: Readonly<Record<string, CliOptionHelpMetadata>>;
};

const metadataByCommand = new WeakMap<Command, CliCommandHelpMetadata>();

/** Associates compatibility metadata that Commander does not retain on public fields. */
const setCliCommandHelpMetadata = (command: Command, metadata: CliCommandHelpMetadata): Command => {
  metadataByCommand.set(command, metadata);
  return command;
};

const toJsonValue = (value: unknown): JsonValue | null => {
  if (value === undefined) {
    return null;
  }

  const serialized = JSON.stringify(value);
  return serialized === undefined ? null : (JSON.parse(serialized) as JsonValue);
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
  default: toJsonValue(argument.defaultValue),
});

const optionValueName = (option: Option): string | null => {
  const match = /(?:<([^>]+)>|\[([^\]]+)\])/.exec(option.flags);
  return match?.[1] ?? match?.[2] ?? null;
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
  repeatable: option.variadic,
  choices: option.argChoices ?? [],
  default: toJsonValue(option.defaultValue),
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

const toCommandHelp = (command: Command): CliHelp['command'] => {
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
    deprecated: metadata?.deprecated ?? null,
    request_schema: metadata?.requestSchema ?? null,
    examples: [...(metadata?.examples ?? [])],
  };
};

/** Builds a validated machine-readable tree for the selected registered command path. */
const createCliHelp = (program: Command, path: readonly string[] = []): CliHelp =>
  cliHelpSchema.parse({
    schema: CLI_HELP_SCHEMA_VERSION,
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

  return sections.filter((section) => section.length > 0).join('\n\n');
};

export {
  createCliHelp,
  renderCliHelp,
  setCliCommandHelpMetadata,
  type CliCommandHelpMetadata,
  type CliOptionHelpMetadata,
};
