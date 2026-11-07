import * as Effect from 'effect/Effect';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import { withEvalApplication } from '@attest/local/eval';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

import { Command, CommanderError } from 'commander';

import { withCommandSignals } from './commands/shared/process-signals.js';
import { registerCloudCommands } from './commands/cloud/register-cloud-commands.js';
import { registerEvalCommands } from './commands/eval/eval-command.js';
import { renderEvalFailureEvent, renderEvalResultLine } from './commands/eval/eval-output.js';
import { registerMetricCommands } from './commands/metric/register-metric-commands.js';
import { registerProjectsCommands } from './commands/projects/register-projects-commands.js';
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
  recoverOutputMode,
} from './commands/shared/cli-options.js';
import {
  resolveAttestPaths,
  type CliIo,
  type CommandContext,
  type CliServices,
} from './commands/shared/command-context.js';
import { registerTestCommands } from './commands/test/registration/register-test-commands.js';
import {
  AttestCliError,
  CliExit,
  renderCliError,
  serializeCliError,
  type SerializedCliFailure,
} from './errors/cli-error.js';
import { resultCommandName, setCliCommandHelpMetadata } from './help/command-help.js';
import { createCliFailureResult, serializeCliResult } from './output/cli-protocol.js';

const require = createRequire(import.meta.url);

type PackageMetadata = {
  name: string;
  version: string;
};

type RunCliOptions = {
  interaction?: Partial<CliInteraction>;
  services?: CliServices;
  io?: CliIo;
  workingDirectory?: string;
};

const defaultIo: CliIo = {
  error: (message) => console.error(message),
  output: (message) => console.log(message),
};

type CliProgram = { failingCommand: () => Command; program: Command };

type CliCompletion = { publish: (failure?: SerializedCliFailure) => number };

/** Builds the public command tree; the returned leaf getter names the command that failed. */
const createProgram = (
  context: Omit<CommandContext, 'program'>,
  writeCommanderError: (message: string) => void,
): CliProgram => {
  // SAFETY: This package's checked-in manifest owns the required name and version fields.
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
  registerCloudCommands(commandContext);
  registerProjectResourceCommands(commandContext);
  registerProjectsCommands(commandContext);
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

/** Parses one CLI invocation and returns an exit code without terminating embedders or tests. */
const runCli = async (argv: string[], options: RunCliOptions = {}): Promise<number> => {
  const completion: CliCompletion = {
    publish: (failure) => {
      if (failure !== undefined) (options.io ?? defaultIo).error(renderCliError(failure.error));

      return failure?.exitCode ?? 0;
    },
  };

  const controller = new AbortController();

  const exit = await Effect.runPromiseExit(
    withCommandSignals(
      () =>
        withEvalApplication(
          Effect.gen(function* () {
            const evalContext = yield* Effect.context<
              | import('@attest/local/eval').EvalApplication
              | import('@attest/local/eval').CancellationRegistry
            >();

            return yield* runCliApplication(
              argv,
              options,
              evalContext,
              completion,
              controller.signal,
            );
          }),
        ),
      controller,
    ),
  );

  if (Exit.isFailure(exit)) {
    const failure = serializeCliError(Cause.squash(exit.cause));

    return completion.publish(failure);
  }

  completion.publish();

  return exit.value;
};

/** Parses Commander input, then executes the selected Effect inside the application scope. */
const runCliApplication = (
  argv: string[],
  options: RunCliOptions,
  evalContext: CommandContext['evalContext'],
  completion: CliCompletion,
  signal: AbortSignal,
) =>
  Effect.gen(function* () {
    let selected:
      | Effect.Effect<
          unknown,
          unknown,
          | import('@attest/local/eval').EvalApplication
          | import('@attest/local/eval').CancellationRegistry
        >
      | undefined;

    let cancellation: Parameters<CommandContext['submit']>[1];

    const interaction = { ...createDefaultCliInteraction(signal), ...options.interaction };

    const prompt: CliInteraction['prompt'] = (question, options) =>
      interaction.prompt(question, { ...options, signal: options?.signal ?? signal });

    const io = options.io ?? defaultIo;
    const workingDirectory = options.workingDirectory ?? process.cwd();
    // Commander's own usage errors wait until the failing command's output mode is known.
    const commanderErrors: string[] = [];

    const { failingCommand, program } = createProgram(
      {
        argv,
        signal,
        submit: (program, options) => {
          selected = program;
          cancellation = options;
        },
        complete: (publish) => {
          completion.publish = publish;
        },
        evalContext,
        services: options.services,
        interaction: { ...interaction, prompt },
        io,
        ...(yield* Effect.tryPromise({
          try: () =>
            resolveAttestPaths({
              attestHome: process.env.ATTEST_HOME,
              homeDirectory: homedir(),
              workingDirectory,
            }),
          catch: (error) => error,
        })),
        workingDirectory,
      },
      (message) => commanderErrors.push(message),
    );

    const reportFailure = (failure: SerializedCliFailure, commanderUsage = false): number => {
      const leaf = failingCommand();

      const command = resultCommandName(leaf);

      const output = commonOutputMode(program, leaf) ?? recoverOutputMode({ program, leaf, argv });

      if (output === 'json' || (output === 'jsonl' && command !== 'eval.run')) {
        io.output(serializeCliResult(createCliFailureResult(command, failure.error)));
      } else if (output === 'jsonl') {
        io.output(renderEvalFailureEvent(failure));
      } else if (commanderUsage) {
        commanderErrors.forEach(io.error);
      } else {
        io.error(renderCliError(failure.error));

        if (leaf.parent?.name() === 'eval') io.output(renderEvalResultLine(failure.exitCode));
      }

      return failure.exitCode;
    };

    completion.publish = (failure) => {
      return failure === undefined ? 0 : reportFailure(failure);
    };

    let commandCause: Cause.Cause<unknown> | undefined;

    try {
      const parsed = yield* Effect.exit(
        Effect.tryPromise({
          try: () => program.parseAsync(argv, { from: 'user' }),
          catch: (error) => error,
        }),
      );

      const cancelled = Effect.callback<never, AttestCliError>((resume) => {
        const abort = () =>
          resume(Effect.fail(new AttestCliError('cancelled', 'Command cancelled.')));

        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });

        return Effect.sync(() => signal.removeEventListener('abort', abort));
      });

      // Owners join terminal evidence or normal shutdown before the root reports failures.
      const execution =
        selected === undefined
          ? undefined
          : cancellation?.cancellation === 'owned'
            ? selected.pipe(
                Effect.catchCause((cause) => {
                  const error = Cause.squash(cause);

                  if (!signal.aborted || error instanceof CliExit) return Effect.failCause(cause);

                  return Effect.fail(
                    new AttestCliError(
                      'cancelled',
                      cancellation?.cancellationMessage ?? 'Command cancelled.',
                      { cause: error },
                    ),
                  );
                }),
              )
            : cancellation?.cancellation === 'shutdown'
              ? selected
              : Effect.raceFirst(selected, cancelled);

      // Commander selects the program; its application owner observes the complete command Exit.
      const executed =
        Exit.isFailure(parsed) || execution === undefined
          ? parsed
          : yield* Effect.exit(execution.pipe(Effect.provideContext(evalContext)));

      if (Exit.isFailure(executed)) {
        commandCause = executed.cause;
        throw Cause.squash(executed.cause);
      }

      return 0;
    } catch (error: unknown) {
      if (error instanceof CommanderError && error.exitCode === 0) return 0;

      // A terminal eval verdict is complete, so store release can still replace that verdict.
      if (error instanceof CliExit) return error.exitCode;

      const failure = serializeCliError(error);
      // Commander already owns this primary failure; a later store release cannot replace it.
      completion.publish = () => reportFailure(failure, error instanceof CommanderError);

      // The application must see failure before joining admitted runs. Publication waits for release.
      return yield* Effect.failCause(commandCause ?? Cause.die(error));
    }
  });

export { runCli, type RunCliOptions };
