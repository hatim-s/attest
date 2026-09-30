import { createRequire } from 'node:module';

import { diffToJson } from '@attest/core';
import {
  compareLocalRuns,
  runReportCommand,
  runTraceConvertCommand,
  runViewCommand,
} from '@attest/local/runs';
import { Command, CommanderError, Option } from 'commander';

import {
  registerEvalCommands,
  renderEvalFailureEvent,
  renderEvalResultLine,
} from './commands/eval/eval-command.js';
import { registerMetricCommands } from './commands/metric/register-metric-commands.js';
import { registerProjectResourceCommands } from './commands/register-project-resource-commands.js';
import {
  createDefaultCliInteraction,
  type CliInteraction,
} from './commands/shared/cli-interaction.js';
import {
  commonOption,
  commonOutputMode,
  inheritCommonOptions,
  nonInteractiveOption,
  outputOption,
  projectOption,
} from './commands/shared/cli-options.js';
import type { CliIo, CommandContext } from './commands/shared/command-context.js';
import { renderResult } from './commands/shared/command-result.js';
import { withProcessSignals } from './commands/shared/process-signals.js';
import { registerTestCommands } from './commands/test/registration/register-test-commands.js';
import { AttestCliError, CliExit, renderCliError, serializeCliError } from './errors/cli-error.js';
import { createCliErrorCatalog, renderCliErrorCatalog } from './errors/error-catalog.js';
import {
  createCliHelp,
  renderCliHelp,
  resultCommandName,
  setCliCommandHelpMetadata,
} from './help/command-help.js';
import { createCliFailureResult, serializeCliResult } from './output/cli-protocol.js';
import { renderDiffSummary } from './output/render-output.js';
import { openBrowser } from './view/open-browser.js';

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

type DiffCommandOptions = {
  format: 'human' | 'json';
  store?: string;
};

type ViewCommandOptions = {
  open: boolean;
  port: number;
  store: string;
};

type ReportCommandOptions = {
  force?: boolean;
  output?: string;
  store: string;
};

type TraceConvertCommandOptions = {
  force?: boolean;
  output?: string;
  traceId?: string;
};

type ProtocolCommandOptions = {
  output: 'human' | 'json';
};

const defaultIo: CliIo = {
  error: (message) => console.error(message),
  output: (message) => console.log(message),
};

const parsePort = (value: string): number => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new AttestCliError('cli_usage', 'View port must be an integer from 0 to 65535.', {
      path: '--port',
      hint: 'Pass an integer from 0 to 65535.',
    });
  }
  return port;
};

/** Registers the run-store, trace, and protocol commands that sit directly under the root. */
const registerRootCommands = ({ io, program, workingDirectory }: CommandContext): void => {
  program
    .command('view')
    .description('Open the local dashboard over the project run store.')
    .option('--store <path>', 'SQLite run store path', '.attest/runs.db')
    .option('--port <port>', 'loopback port; 0 chooses a free port', parsePort, 0)
    .option('--no-open', 'do not launch a browser')
    .action(async (options: ViewCommandOptions) => {
      await withProcessSignals((signal) =>
        runViewCommand({
          onReady: async ({ url }) => {
            io.output(`Attest view: ${url}\nPress Ctrl+C to stop.`);
            if (options.open) await openBrowser(url);
          },
          port: options.port,
          signal,
          storePath: options.store,
          workingDirectory,
        }),
      );
    });

  program
    .command('report')
    .description('Write a self-contained HTML report for one persisted run.')
    .argument('<run-id>', 'run id to export')
    .option('--store <path>', 'SQLite run store path', '.attest/runs.db')
    .option('-o, --output <path>', 'HTML output path')
    .option('--force', 'replace an existing report')
    .action(async (runId: string, options: ReportCommandOptions) => {
      const result = await runReportCommand({
        force: options.force,
        outputPath: options.output,
        runId,
        storePath: options.store,
        workingDirectory,
      });
      io.output(`Wrote ${result.caseCount}-case report to ${result.outputPath}`);
      if (result.truncated) {
        io.error(
          `report_truncated: Included the first ${result.caseCount} of ${result.totalCaseCount} cases.`,
        );
      }
    });

  program
    .command('trace')
    .description('Convert and inspect trace data.')
    .command('convert')
    .description('Convert an OTLP/HTTP JSON export to attest.trace JSON.')
    .argument('<input>', 'OTLP JSON input path')
    .option('--trace-id <trace-id>', 'trace id to select from a multi-trace export')
    .option('-o, --output <path>', 'Attest trace output path')
    .option('--force', 'replace an existing output file')
    .action(async (inputPath: string, options: TraceConvertCommandOptions) => {
      const result = await runTraceConvertCommand({
        force: options.force,
        inputPath,
        outputPath: options.output,
        traceId: options.traceId,
        workingDirectory,
      });
      io.output(
        result.outputPath === undefined
          ? result.json
          : `Wrote ${result.spanCount}-span trace ${result.traceId} to ${result.outputPath}`,
      );
    });

  program
    .command('diff')
    .description('Compare two persisted runs.')
    .argument('<base-run-id>', 'baseline run id')
    .argument('<candidate-run-id>', 'candidate run id')
    .option('--store <path>', 'SQLite run store path', '.attest/runs.db')
    .addOption(
      new Option('--format <format>', 'terminal or machine-readable output')
        .choices(['human', 'json'])
        .default('human'),
    )
    .action(async (baseRunId: string, candidateRunId: string, options: DiffCommandOptions) => {
      const diff = await compareLocalRuns({
        baseRunId,
        candidateRunId,
        storePath: options.store,
        workingDirectory,
      });
      io.output(options.format === 'json' ? diffToJson(diff) : renderDiffSummary(diff));
    });

  const help = program
    .command('help [command...]')
    .description('Show human or machine-readable help for a registered command path.')
    .addOption(commonOption(outputOption('help output format').default('human')))
    .action((commandPath: string[], options: ProtocolCommandOptions) => {
      io.output(
        renderResult('help', options.output, createCliHelp(program, commandPath), renderCliHelp),
      );
    });
  setCliCommandHelpMetadata(help, {
    examples: ['attest help test case import --output json'],
    options: { output: { implies: ['non-interactive'] } },
  });

  const errors = program
    .command('errors')
    .description('List stable CLI error identities, exit codes, and repairs.')
    .addOption(commonOption(outputOption('error catalog output format').default('human')))
    .action((options: ProtocolCommandOptions) => {
      io.output(
        renderResult('errors', options.output, createCliErrorCatalog(), renderCliErrorCatalog),
      );
    });
  setCliCommandHelpMetadata(errors, {
    examples: ['attest errors --output json'],
    options: { output: { implies: ['non-interactive'] } },
  });
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
    const command = resultCommandName(leaf);
    const output = commonOutputMode(program, leaf);
    if (output === 'json') {
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
