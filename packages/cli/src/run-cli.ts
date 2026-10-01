import { createRequire } from 'node:module';

import { Command, CommanderError } from 'commander';

import { registerEvalCommands } from './commands/eval/eval-command.js';
import { renderEvalFailureEvent, renderEvalResultLine } from './commands/eval/eval-output.js';
import { registerMetricCommands } from './commands/metric/register-metric-commands.js';
import { registerProjectResourceCommands } from './commands/register-project-resource-commands.js';
import { registerRootCommands } from './commands/register-root-commands.js';
import {
  createDefaultCliInteraction,
  type CliInteraction,
} from './commands/shared/cli-interaction.js';
import {
  commonOutputMode,
  inheritCommonOptions,
  nonInteractiveOption,
  outputOption,
  projectOption,
} from './commands/shared/cli-options.js';
import type { CliIo, CommandContext } from './commands/shared/command-context.js';
import { registerTestCommands } from './commands/test/registration/register-test-commands.js';
import { CliExit, renderCliError, serializeCliError } from './errors/cli-error.js';
import { resultCommandName, setCliCommandHelpMetadata } from './help/command-help.js';
import { createCliFailureResult, serializeCliResult } from './output/cli-protocol.js';

const require = createRequire(import.meta.url);

type PackageMetadata = {
  name: string;
  version: string;
};

type RunCliOptions = {
  interaction?: Partial<CliInteraction>;
  io?: CliIo;
  workingDirectory?: string;
};

const defaultIo: CliIo = {
  error: (message) => console.error(message),
  output: (message) => console.log(message),
};

/** Builds the public command tree; the returned leaf getter names the command that failed. */
const createProgram = (
  context: Omit<CommandContext, 'program'>,
  writeCommanderError: (message: string) => void,
): { failingCommand: () => Command; program: Command } => {
  const packageMetadata = require('../package.json') as PackageMetadata;
  const program = new Command()
    .name('attest')
    .enablePositionalOptions()
    .description('Run reproducible evaluations for CLI and HTTP AI agents.')
    .version(packageMetadata.version)
    .showHelpAfterError()
    .configureOutput({ writeOut: context.io.output, writeErr: writeCommanderError })
    .addOption(projectOption())
    .addOption(outputOption())
    .addOption(nonInteractiveOption());

  const commandContext = { ...context, program };
  registerRootCommands(commandContext);
  registerProjectResourceCommands(commandContext);
  registerMetricCommands(commandContext);
  registerTestCommands(commandContext);
  registerEvalCommands(commandContext);
  setCliCommandHelpMetadata(program, {
    examples: [
      'attest help --output json',
      'attest errors --output json',
      'attest project init',
      'attest list agents --output json',
      'attest eval run --all --output jsonl',
    ],
  });

  let failing = program;
  const trackFailures = (command: Command): void => {
    command.exitOverride((error) => {
      failing = command;
      throw error;
    });
    command.commands.forEach(trackFailures);
  };
  trackFailures(program);
  program.hook('preAction', (_root, leaf) => {
    failing = leaf;
    inheritCommonOptions(program, leaf);
  });
  return { failingCommand: () => failing, program };
};

/** Honors machine output even when an agent misspells a command before parsing succeeds. */
const requestedStructuredOutput = (argv: readonly string[]): 'json' | 'jsonl' | undefined => {
  // These commands retain artifact-path or legacy --format semantics.
  if (['view', 'report', 'trace.convert', 'diff'].includes(requestedCommand(argv))) return;
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--') break;
    if (argument === '--output') output = argv[++index];
    else if (argument.startsWith('--output=')) output = argument.slice('--output='.length);
  }
  return output === 'json' || output === 'jsonl' ? output : undefined;
};

/** Removes only recognized global common options before identifying the requested command. */
const commandArguments = (argv: readonly string[]): string[] => {
  const argumentsWithoutGlobals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--project' || argument === '--output') {
      index += 1;
    } else if (
      argument === '--non-interactive' ||
      argument.startsWith('--project=') ||
      argument.startsWith('--output=')
    ) {
      continue;
    } else {
      argumentsWithoutGlobals.push(argument);
    }
  }
  return argumentsWithoutGlobals;
};

const requestedCommand = (argv: readonly string[]): string => {
  const normalizedArguments = commandArguments(argv);
  const first = normalizedArguments[0];
  const second = normalizedArguments[1];
  if (first === undefined || first.startsWith('-')) {
    return 'cli';
  }
  if (first === 'trace' && second === 'convert') {
    return 'trace.convert';
  }
  if (first === 'init') {
    return 'project.init';
  }
  if (first === 'project' && ['init', 'show', 'validate'].includes(second ?? '')) {
    return `project.${second}`;
  }
  if (first === 'agent' && ['add', 'import', 'test', 'rename', 'remove'].includes(second ?? '')) {
    return `agent.${second}`;
  }
  if (first === 'metric' && ['add', 'import', 'test', 'rename', 'remove'].includes(second ?? '')) {
    return `metric.${second}`;
  }
  if (first === 'schema' && ['list', 'print'].includes(second ?? '')) {
    return `schema.${second}`;
  }
  if (first === 'eval' && ['run', 'cancel'].includes(second ?? '')) {
    return `eval.${second}`;
  }
  if (first === 'test') {
    const third = normalizedArguments[2];
    if (second === 'case' && third !== undefined && !third.startsWith('-')) {
      return `test.case.${third}`;
    }
    if (second === 'dataset' && third !== undefined && !third.startsWith('-')) {
      return `test.dataset.${third}`;
    }
    if (second !== undefined && !second.startsWith('-')) return `test.${second}`;
  }
  return /^[a-z][a-z0-9-]*$/.test(first) ? first : 'cli';
};

/** Parses one CLI invocation and returns an exit code without terminating embedders or tests. */
const runCli = async (argv: string[], options: RunCliOptions = {}): Promise<number> => {
  const io = options.io ?? defaultIo;
  // Commander's own usage errors wait until the failing command's output mode is known.
  const commanderErrors: string[] = [];
  const { failingCommand, program } = createProgram(
    {
      argv,
      interaction: { ...createDefaultCliInteraction(), ...options.interaction },
      io,
      workingDirectory: options.workingDirectory ?? process.cwd(),
    },
    (message) => commanderErrors.push(message),
  );

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error: unknown) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    if (error instanceof CliExit) return error.exitCode;

    const failure = serializeCliError(error);
    const leaf = failingCommand();
    const command =
      error instanceof CommanderError ? requestedCommand(argv) : resultCommandName(leaf);
    const output = requestedStructuredOutput(argv) ?? commonOutputMode(program, leaf);
    if (output === 'json' || (output === 'jsonl' && command !== 'eval.run')) {
      io.output(serializeCliResult(createCliFailureResult(command, failure.error)));
    } else if (output === 'jsonl') {
      io.output(renderEvalFailureEvent(failure));
    } else if (error instanceof CommanderError) {
      commanderErrors.forEach(io.error);
    } else {
      io.error(renderCliError(failure.error));
      if (leaf.parent?.name() === 'eval') io.output(renderEvalResultLine(failure.exitCode));
    }
    return failure.exitCode;
  }
};

export { runCli, type RunCliOptions };
