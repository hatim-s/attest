import { diffToJson } from '@attest/core';
import {
  compareLocalRuns,
  runReportCommand,
  runTraceConvertCommand,
  runViewCommand,
} from '@attest/local/runs';
import { Option } from 'commander';

import { AttestCliError } from '../errors/cli-error.js';
import { createCliErrorCatalog, renderCliErrorCatalog } from '../errors/error-catalog.js';
import { createCliHelp, renderCliHelp, setCliCommandHelpMetadata } from '../help/command-help.js';
import { renderDiffSummary } from '../output/render-output.js';
import { openBrowser } from '../view/open-browser.js';
import { commonOption, outputOption } from './shared/cli-options.js';
import type { CommandContext } from './shared/command-context.js';
import { renderResult } from './shared/command-result.js';
import { withProcessSignals } from './shared/process-signals.js';

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

export { registerRootCommands };
