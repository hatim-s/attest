import { Command, Option } from 'commander';

import { AttestCliError } from '../../errors/index.js';

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

type InteractionState = {
  ci: boolean;
  inputIsTTY: boolean;
  outputIsTTY: boolean;
};

/** Collects one repeatable Commander option without mutating prior parser state. */
const collectOption = (value: string, previous: string[] | undefined): string[] => [
  ...(previous ?? []),
  value,
];

/** Adds the common project, output, and prompt controls used by resource commands. */
const addCommonOptions = (command: Command): Command =>
  command
    .option('--project <dir>', 'explicit Attest project directory')
    .addOption(new Option('--output <format>', 'output format').choices(['human', 'json']))
    .option('--non-interactive', 'disable prompts and fail when required input is missing');

/** Adds transactional request controls on top of the common resource options. */
const addMutationOptions = (
  command: Command,
  yesDescription = 'accept confirmation prompts without inventing missing values',
): Command =>
  addCommonOptions(command)
    .option('--dry-run', 'validate and show the semantic diff without writing')
    .option('--yes', yesDescription)
    .option('--from-json <path|->', 'read one command request from a file or stdin')
    .option('--if-project-hash <sha256>', 'fail if the project changed since it was read');

const outputFormat = (options: CommonCliOptions): 'human' | 'json' => options.output ?? 'human';

/** Merges root-position common options with command-position options and rejects ambiguity. */
const mergeCommonOptions = <Options extends CommonCliOptions>(
  options: Options,
  command: Command,
  program: Command,
): Options => {
  const root = program.opts<CommonCliOptions>();
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
  return { ...root, ...options };
};

const isInteractive = (
  options: CommonCliOptions,
  interaction: InteractionState,
  fromJson?: string,
): boolean =>
  options.nonInteractive !== true &&
  outputFormat(options) === 'human' &&
  fromJson === undefined &&
  !interaction.ci &&
  interaction.inputIsTTY &&
  interaction.outputIsTTY;

export {
  addCommonOptions,
  addMutationOptions,
  collectOption,
  isInteractive,
  mergeCommonOptions,
  outputFormat,
  type CommonCliOptions,
  type MutationCliOptions,
};
