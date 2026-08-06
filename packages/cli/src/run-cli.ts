import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import { AttestError } from '@attest/contracts';
import { diffRuns, openStore, runToJUnitXml } from '@attest/core';
import { Command, CommanderError, Option } from 'commander';

import { loadConfig } from './config/load-config.js';
import { AttestCliError } from './errors.js';
import { initProject } from './init/init-project.js';
import {
  diffToJson,
  renderDiffSummary,
  renderRunJson,
  renderRunSummary,
  runExitCode,
} from './output/render-output.js';
import { runConfiguration } from './run/run-configuration.js';
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

type InitCommandOptions = {
  force?: boolean;
};

type ViewCommandOptions = {
  open: boolean;
  port: number;
  store: string;
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

const renderCliError = (error: unknown): string => {
  if (error instanceof AttestError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return `internal_error: ${error.message}`;
  }
  return 'internal_error: The command failed with an unknown error.';
};

const parsePort = (value: string): number => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new AttestCliError('run_failed', 'View port must be an integer from 0 to 65535.');
  }
  return port;
};

/** Builds the public command tree while keeping command effects behind narrow action callbacks. */
const createProgram = (
  io: CliIo,
  workingDirectory: string,
  setExitCode: (exitCode: 0 | 1) => void,
): Command => {
  const packageMetadata = require('../package.json') as PackageMetadata;
  const program = new Command()
    .name('attest')
    .description('Run reproducible evaluations for CLI and HTTP AI agents.')
    .version(packageMetadata.version)
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: io.output,
      writeErr: io.error,
    });

  program
    .command('init')
    .description('Create a runnable local quickstart without overwriting files by default.')
    .argument('[directory]', 'target project directory', '.')
    .option('--force', 'replace generated files that already exist')
    .action(async (directory: string, options: InitCommandOptions) => {
      const result = await initProject(directory, workingDirectory, { force: options.force });
      const fileList = result.files
        .map((filePath) => `  ${relative(result.targetDirectory, filePath)}`)
        .join('\n');
      io.output(
        `Initialized Attest quickstart in ${result.targetDirectory}:\n${fileList}\n\nNext: cd ${result.targetDirectory} && attest run`,
      );
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

  return program;
};

/** Parses one CLI invocation and returns an exit code without terminating embedders or tests. */
const runCli = async (argv: string[], options: RunCliOptions = {}): Promise<number> => {
  const io = options.io ?? defaultIo;
  const workingDirectory = options.workingDirectory ?? process.cwd();
  let exitCode: 0 | 1 = 0;
  const program = createProgram(io, workingDirectory, (nextExitCode) => {
    exitCode = nextExitCode;
  });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (error: unknown) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      return 0;
    }
    if (!(error instanceof CommanderError)) {
      io.error(renderCliError(error));
    }
    return 1;
  }
};

export { createProgram, runCli, type CliIo, type RunCliOptions };
