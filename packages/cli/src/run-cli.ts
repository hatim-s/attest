import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { type CliExitCode } from '@attest/contracts';
import { diffRuns, openStore, runToJUnitXml } from '@attest/core';
import { Command, CommanderError, Option } from 'commander';

import { loadConfig } from './config/load-config.js';
import {
  createDefaultCliInteraction,
  registerProjectResourceCommands,
  type CliInteraction,
} from './commands/register-project-resource-commands.js';
import { registerMetricCommands } from './commands/metric/register-metric-commands.js';
import { registerTestCommands } from './commands/test/register-test-commands.js';
import {
  AttestCliError,
  createCliErrorCatalog,
  renderCliError,
  renderCliErrorCatalog,
  serializeCliError,
} from './errors.js';
import { createCliHelp, renderCliHelp, setCliCommandHelpMetadata } from './help/command-help.js';
import {
  diffToJson,
  renderDiffSummary,
  renderRunJson,
  renderRunSummary,
  runExitCode,
} from './output/render-output.js';
import {
  createCliFailureResult,
  createCliSuccessResult,
  serializeCliResult,
} from './output/cli-protocol.js';
import { runConfiguration } from './run/run-configuration.js';
import { runReportCommand } from './report/run-report-command.js';
import { runTraceConvertCommand } from './trace/run-trace-convert-command.js';
import { runViewCommand } from './view/run-view-command.js';

const require = createRequire(import.meta.url);

interface PackageMetadata {
  name: string;
  version: string;
}

type CliIo = {
  error: (message: string) => void;
  output: (message: string) => void;
};

type RunCliOptions = {
  interaction?: Partial<CliInteraction>;
  io?: CliIo;
  workingDirectory?: string;
};

type RunCommandOptions = {
  baseline?: string;
  config?: string;
  format: 'human' | 'json';
  junit?: string;
  store?: string;
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

const writeJUnit = async (
  outputPath: string,
  workingDirectory: string,
  run: Parameters<typeof runToJUnitXml>[0],
  cases: Parameters<typeof runToJUnitXml>[1],
): Promise<void> => {
  const resolvedPath = resolve(workingDirectory, outputPath);
  try {
    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, `${runToJUnitXml(run, cases)}\n`, 'utf8');
  } catch (error: unknown) {
    throw new AttestCliError(
      'output_write_failed',
      `Could not write JUnit output to ${resolvedPath}.`,
      { cause: error },
    );
  }
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

/** Distinguishes the common machine-output option from legacy artifact-path options. */
const acceptsGlobalCommonOption = (command: Command, name: string): boolean => {
  const option = command.options.find((candidate) => candidate.attributeName() === name);
  if (option === undefined) return false;
  if (name !== 'output') return true;
  return (
    option.argChoices?.length === 2 &&
    option.argChoices.includes('human') &&
    option.argChoices.includes('json')
  );
};

/** Builds the public command tree while keeping command effects behind narrow action callbacks. */
const createProgram = (
  io: CliIo,
  workingDirectory: string,
  setExitCode: (exitCode: CliExitCode) => void,
  interaction: CliInteraction = createDefaultCliInteraction(),
): Command => {
  const packageMetadata = require('../package.json') as PackageMetadata;
  const program = new Command()
    .name('attest')
    .enablePositionalOptions()
    .description('Run reproducible evaluations for CLI and HTTP AI agents.')
    .version(packageMetadata.version)
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: io.output,
      writeErr: io.error,
    });

  program
    .option('--project <dir>', 'explicit Attest project directory')
    .addOption(new Option('--output <format>', 'output format').choices(['human', 'json']))
    .option('--non-interactive', 'disable prompts and fail when required input is missing');
  program.hook('preAction', (_rootCommand, actionCommand) => {
    const globalOptions = program.opts<{
      nonInteractive?: boolean;
      output?: 'human' | 'json';
      project?: string;
    }>();
    // Leaf commands retain a locally positioned value; otherwise inherit the normative global flag.
    for (const [name, value] of Object.entries(globalOptions)) {
      const localSource = actionCommand.getOptionValueSource(name);
      if (
        value !== undefined &&
        acceptsGlobalCommonOption(actionCommand, name) &&
        (localSource === undefined || localSource === 'default')
      ) {
        actionCommand.setOptionValueWithSource(name, value, 'implied');
      }
    }
  });

  program
    .command('view')
    .description('Open the local dashboard over the project run store.')
    .option('--store <path>', 'SQLite run store path', '.attest/runs.db')
    .option('--port <port>', 'loopback port; 0 chooses a free port', parsePort, 0)
    .option('--no-open', 'do not launch a browser')
    .action(async (options: ViewCommandOptions) => {
      const abortController = new AbortController();
      const stop = (): void => abortController.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        await runViewCommand({
          launchBrowser: options.open,
          onReady: ({ url }) => io.output(`Attest view: ${url}\nPress Ctrl+C to stop.`),
          port: options.port,
          signal: abortController.signal,
          storePath: options.store,
          workingDirectory,
        });
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
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

  const traceCommand = program.command('trace').description('Convert and inspect trace data.');
  traceCommand
    .command('convert')
    .description('Convert an OTLP/HTTP JSON export to attest.trace/v1alpha1 JSON.')
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
    .command('run')
    .description('Execute a config, evaluate metrics, and persist the run.')
    .option('-c, --config <path>', 'config path; otherwise use documented discovery order')
    .option('--store <path>', 'SQLite run store path')
    .option('--baseline <run-id>', 'include a diff against an earlier run')
    .option('--junit <path>', 'write JUnit XML for CI')
    .addOption(
      new Option('--format <format>', 'terminal or machine-readable output')
        .choices(['human', 'json'])
        .default('human'),
    )
    .action(async (options: RunCommandOptions) => {
      const loadedConfig = await loadConfig(options.config, workingDirectory);
      const result = await runConfiguration(loadedConfig, {
        baselineRunId: options.baseline,
        storePath: options.store,
      });
      if (options.junit !== undefined) {
        await writeJUnit(options.junit, workingDirectory, result.run, result.cases);
      }
      io.output(options.format === 'json' ? renderRunJson(result) : renderRunSummary(result));
      setExitCode(runExitCode(result.run));
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
      const storePath = resolve(workingDirectory, options.store ?? '.attest/runs.db');
      const store = await openStore(storePath);
      try {
        const diff = await diffRuns(store.runs, baseRunId, candidateRunId);
        io.output(options.format === 'json' ? diffToJson(diff) : renderDiffSummary(diff));
      } finally {
        await store.close();
      }
    });

  const helpCommand = program
    .command('help [command...]')
    .description('Show human or machine-readable help for a registered command path.')
    .addOption(
      new Option('--output <format>', 'help output format')
        .choices(['human', 'json'])
        .default('human'),
    )
    .action((commandPath: string[], options: ProtocolCommandOptions, action: Command) => {
      const help = createCliHelp(program, commandPath);
      if (
        program.getOptionValueSource('output') === 'cli' &&
        action.getOptionValueSource('output') === 'cli'
      ) {
        throw new AttestCliError('cli_usage', 'Common option --output was provided twice.', {
          path: '--output',
        });
      }
      const output =
        program.getOptionValueSource('output') === 'cli'
          ? (program.opts<ProtocolCommandOptions>().output ?? options.output)
          : options.output;
      io.output(
        output === 'json'
          ? serializeCliResult(createCliSuccessResult('help', help))
          : renderCliHelp(help),
      );
    });
  setCliCommandHelpMetadata(helpCommand, {
    examples: ['attest help test case import --output json'],
    options: { output: { implies: ['non-interactive'] } },
  });

  const errorsCommand = program
    .command('errors')
    .description('List stable CLI error identities, exit codes, and repairs.')
    .addOption(
      new Option('--output <format>', 'error catalog output format')
        .choices(['human', 'json'])
        .default('human'),
    )
    .action((options: ProtocolCommandOptions, action: Command) => {
      const catalog = createCliErrorCatalog();
      if (
        program.getOptionValueSource('output') === 'cli' &&
        action.getOptionValueSource('output') === 'cli'
      ) {
        throw new AttestCliError('cli_usage', 'Common option --output was provided twice.', {
          path: '--output',
        });
      }
      const output =
        program.getOptionValueSource('output') === 'cli'
          ? (program.opts<ProtocolCommandOptions>().output ?? options.output)
          : options.output;
      io.output(
        output === 'json'
          ? serializeCliResult(createCliSuccessResult('errors', catalog))
          : renderCliErrorCatalog(catalog),
      );
    });
  setCliCommandHelpMetadata(errorsCommand, {
    examples: ['attest errors --output json'],
    options: { output: { implies: ['non-interactive'] } },
  });

  registerProjectResourceCommands({
    interaction,
    io,
    program,
    workingDirectory,
  });
  registerMetricCommands({ interaction, io, program, workingDirectory });
  registerTestCommands({ interaction, io, program, workingDirectory });

  setCliCommandHelpMetadata(program, {
    examples: [
      'attest help --output json',
      'attest errors --output json',
      'attest project init',
      'attest list agents --output json',
    ],
  });

  return program;
};

const requestedStructuredOutput = (argv: readonly string[]): boolean => {
  const command = requestedCommand(argv);
  const supportsStructuredOutput =
    command === 'help' ||
    command === 'errors' ||
    command === 'init' ||
    command === 'list' ||
    command === 'show' ||
    command.startsWith('project.') ||
    command.startsWith('agent.') ||
    command.startsWith('metric.') ||
    command.startsWith('schema.') ||
    command.startsWith('test.');
  return (
    supportsStructuredOutput &&
    argv.some(
      (argument, index) =>
        argument === '--output=json' ||
        argument === '--output=jsonl' ||
        (argument === '--output' && (argv[index + 1] === 'json' || argv[index + 1] === 'jsonl')),
    )
  );
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
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const structuredOutput = requestedStructuredOutput(argv);
  const commandIo: CliIo = structuredOutput ? { output: io.output, error: () => undefined } : io;
  let exitCode: CliExitCode = 0;
  const defaultInteraction = createDefaultCliInteraction();
  const interaction = { ...defaultInteraction, ...options.interaction };
  if (
    options.interaction?.readStdin !== undefined &&
    options.interaction.readImportStdin === undefined
  ) {
    // Test and embedding callers with a text stdin override retain parity without touching process stdin.
    interaction.readImportStdin = async function* readImportStdin() {
      yield await options.interaction!.readStdin!();
    };
  }
  const program = createProgram(
    commandIo,
    workingDirectory,
    (nextExitCode) => {
      exitCode = nextExitCode;
    },
    interaction,
  );

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (error: unknown) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      return 0;
    }

    const failure = serializeCliError(error);
    if (structuredOutput) {
      io.output(serializeCliResult(createCliFailureResult(requestedCommand(argv), failure.error)));
    } else if (!(error instanceof CommanderError)) {
      io.error(renderCliError(failure.error));
    }
    return failure.exitCode;
  }
};

export { createProgram, runCli, type CliIo, type RunCliOptions };
