import { COMMAND_REQUEST_SCHEMA_ID, type EvalOutputMode } from '@attest/contracts';
import { Option, type Command } from 'commander';

import { AttestCliError } from '../../errors/cli-error.js';
import type { CliInteraction } from './cli-interaction.js';
import type { PromptContext } from './required-input.js';

type CommonCliOptions = {
  nonInteractive?: boolean;
  output?: 'human' | 'json';
  project?: string;
};

type MutationCliOptions = CommonCliOptions & {
  dryRun?: boolean;
  fromJson?: string;
  ifProjectHash?: string;
  yes?: boolean;
};

/**
 * Leaf options that may also be written before the command path. Tracking the Option objects
 * keeps `report -o <path>` and `diff --format` out of the root `--output` inheritance.
 */
const commonOptions = new WeakSet<Option>();

/** Marks a leaf option as one the root `--project`, `--output`, or `--non-interactive` feeds. */
const commonOption = (option: Option): Option => {
  commonOptions.add(option);

  return option;
};

/** Options every command request carries, so they never count as authored fields. */
const REQUEST_CONTROL_OPTIONS: ReadonlySet<string> = new Set([
  'dry-run',
  'from-json',
  'if-project-hash',
  'non-interactive',
  'output',
  'project',
  'yes',
]);

/** Names the arguments and options a user authors a request with, in registration order. */
const authoredFieldNames = (command: Command): string[] => [
  ...command.registeredArguments.map((argument) => argument.name()),
  ...command.options
    .map((option) => option.name())
    .filter((name) => !REQUEST_CONTROL_OPTIONS.has(name)),
];

/** Commander retains authored arguments, including empty strings, separately from defaults. */
const authoredFieldPresence = (
  command: Command,
  excludedOptions: ReadonlySet<string> = new Set([
    'from-json',
    'non-interactive',
    'output',
    'project',
  ]),
): ReadonlySet<string> => {
  const fields = new Set<string>();

  for (const [index, argument] of command.registeredArguments.entries()) {
    if (index < command.args.length) fields.add(argument.name());
  }

  for (const option of command.options) {
    const source = command.getOptionValueSource(option.attributeName());

    if (!excludedOptions.has(option.name()) && (source === 'cli' || source === 'implied')) {
      fields.add(option.name());
    }
  }

  return fields;
};

/** Collects a repeatable option; help reports every option parsed by it as repeatable. */
const collect = (value: string, previous: string[] | undefined): string[] => [
  ...(previous ?? []),
  value,
];

/** Builds the `--project` option shared by the root program and project-reading commands. */
const projectOption = (): Option =>
  new Option('--project <dir>', 'explicit Attest project directory');

/** Builds an `--output` format option; eval run adds `jsonl` to the default choices. */
const outputOption = (
  description = 'output format',
  choices: readonly string[] = ['human', 'json'],
): Option => new Option('--output <format>', description).choices(choices);

/** Builds the `--non-interactive` switch with a description of what fails instead of prompting. */
const nonInteractiveOption = (
  description = 'disable prompts and fail when required input is missing',
): Option => new Option('--non-interactive', description);

/** Adds the common project, output, and prompt controls used by resource commands. */
const addCommonOptions = (command: Command): Command =>
  command
    .addOption(commonOption(projectOption()))
    .addOption(commonOption(outputOption()))
    .addOption(commonOption(nonInteractiveOption()));

/** Adds transactional request controls on top of the common resource options. */
const addMutationOptions = (command: Command): Command =>
  addCommonOptions(command)
    .option('--dry-run', 'validate and show the semantic diff without writing')
    .option('--yes', 'accept confirmation prompts without inventing missing values')
    .option('--from-json <path|->', 'read one command request from a file or stdin')
    .option('--if-project-hash <sha256>', 'fail if the project changed since it was read');

/**
 * Copies common flags written before the command path onto the leaf, so actions read one
 * options object. The same flag in both positions is ambiguous and rejected.
 */
const inheritCommonOptions = (program: Command, leaf: Command): void => {
  for (const option of leaf.options) {
    if (!commonOptions.has(option)) continue;
    const name = option.attributeName();

    if (program.getOptionValueSource(name) !== 'cli') continue;

    if (leaf.getOptionValueSource(name) === 'cli') {
      throw new AttestCliError('cli_usage', `Common option ${option.long} was provided twice.`, {
        path: option.long,
      });
    }

    leaf.setOptionValueWithSource(name, program.getOptionValue(name), 'implied');
  }
};

/** Finds the leaf's common `--output` value; undefined for commands without one. */
const commonOutputMode = (program: Command, leaf: Command): string | undefined => {
  const output = leaf.options.find(
    (option) => commonOptions.has(option) && option.attributeName() === 'output',
  );

  if (output === undefined) return undefined;
  const leafValue = leaf.opts<{ output?: EvalOutputMode }>().output;
  const source = leaf.getOptionValueSource('output');

  // Commander may fail before the preAction hook copied a root-position `--output`.
  const inherited =
    source === undefined || source === 'default'
      ? program.opts<{ output?: EvalOutputMode }>().output
      : undefined;

  const value = inherited ?? leafValue;

  return value === 'human' || value === 'json' || value === 'jsonl' ? value : undefined;
};

const outputFormat = (options: CommonCliOptions): 'human' | 'json' => options.output ?? 'human';

/** Prompts are allowed only for human output on a real terminal outside CI. */
const isInteractive = (
  options: { nonInteractive?: boolean; output?: string },
  interaction: Pick<CliInteraction, 'ci' | 'inputIsTTY' | 'outputIsTTY'>,
  fromJson?: string,
): boolean =>
  options.nonInteractive !== true &&
  (options.output ?? 'human') === 'human' &&
  fromJson === undefined &&
  !interaction.ci &&
  interaction.inputIsTTY &&
  interaction.outputIsTTY;

/** Prompts for missing values only when the command may be interactive. */
const promptContext = (
  options: { fromJson?: string; nonInteractive?: boolean; output?: string },
  interaction: CliInteraction,
): PromptContext => ({
  interactive: isInteractive(options, interaction, options.fromJson),
  prompt: interaction.prompt,
});

/** Builds the request envelope fields that the mutation flags map to. */
type MutationRequestControls<TCommand extends string> = {
  schema: typeof COMMAND_REQUEST_SCHEMA_ID;
  command: TCommand;
  dry_run?: boolean;
  if_project_hash?: string;
  yes?: boolean;
};

const mutationRequestFields = <TCommand extends string>(
  command: TCommand,
  options: MutationCliOptions,
): MutationRequestControls<TCommand> => {
  const fields: MutationRequestControls<TCommand> = { schema: COMMAND_REQUEST_SCHEMA_ID, command };

  if (options.dryRun !== undefined) fields.dry_run = options.dryRun;

  if (options.ifProjectHash !== undefined) fields.if_project_hash = options.ifProjectHash;

  if (options.yes !== undefined) fields.yes = options.yes;

  return fields;
};

export {
  addCommonOptions,
  addMutationOptions,
  authoredFieldNames,
  authoredFieldPresence,
  collect,
  commonOption,
  commonOutputMode,
  inheritCommonOptions,
  isInteractive,
  mutationRequestFields,
  nonInteractiveOption,
  outputFormat,
  outputOption,
  projectOption,
  promptContext,
  type CommonCliOptions,
  type MutationCliOptions,
};
