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
    .description('Run reproducible evaluations for CLI and HTTP AI agents.')
    .version(packageMetadata.version)
    .showHelpAfterError()
    .exitOverride()
    .option('--project <dir>', 'explicit Attest project directory')
    .addOption(
      new Option('--output <format>', 'output format').choices(['human', 'json']).default('human'),
    )
    .option('--non-interactive', 'disable prompts and fail when required input is missing')
    .configureOutput({
      writeOut: io.output,
      writeErr: io.error,
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
    .action((commandPath: string[], options: ProtocolCommandOptions) => {
      const help = createCliHelp(program, commandPath);
      const output =
        options.output === 'json' || program.opts<ProtocolCommandOptions>().output === 'json'
          ? 'json'
          : 'human';
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
    .action((options: ProtocolCommandOptions) => {
      const catalog = createCliErrorCatalog();
      const output =
        options.output === 'json' || program.opts<ProtocolCommandOptions>().output === 'json'
          ? 'json'
          : 'human';
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

  setCliCommandHelpMetadata(program, {
    examples: [
      'attest help --output json',
      'attest errors --output json',
      'attest project init',
      'attest list agents --output json',
    ],
    options: { output: { implies: ['non-interactive'] } },
  });

  return program;
};

const requestedStructuredOutput = (argv: readonly string[]): boolean => {
  return argv.some(
    (argument, index) =>
      argument === '--output=json' ||
      argument === '--output=jsonl' ||
      (argument === '--output' && (argv[index + 1] === 'json' || argv[index + 1] === 'jsonl')),
  );
};

const requestedCommand = (argv: readonly string[]): string => {
  let commandIndex = 0;
  while (commandIndex < argv.length) {
    const argument = argv[commandIndex];
    if (argument === '--project' || argument === '--output') {
      commandIndex += 2;
      continue;
    }
    if (
      argument === '--non-interactive' ||
      argument?.startsWith('--project=') === true ||
      argument?.startsWith('--output=') === true
    ) {
      commandIndex += 1;
      continue;
    }
    break;
  }
  const first = argv[commandIndex];
  const second = argv[commandIndex + 1];
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
  return /^[a-z][a-z0-9-]*$/.test(first) ? first : 'cli';
};

/** Parses one CLI invocation and returns an exit code without terminating embedders or tests. */
const runCli = async (argv: string[], options: RunCliOptions = {}): Promise<number> => {
  const io = options.io ?? defaultIo;
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const structuredOutput = requestedStructuredOutput(argv);
  const commandIo: CliIo = structuredOutput ? { output: io.output, error: () => undefined } : io;
  let exitCode: CliExitCode = 0;
  const interaction = { ...createDefaultCliInteraction(), ...options.interaction };
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
