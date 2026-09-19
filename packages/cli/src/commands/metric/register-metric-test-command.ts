import { COMMAND_REQUEST_SCHEMA_ID } from '@attest/contracts';
import {
  readMetricCommandRequest,
  runMetricTestCommand,
  validateMetricCommandRequest,
} from '@attest/local/metric';
import type { Command } from 'commander';

import { AttestCliError } from '../../errors/index.js';
import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import { renderCommandResult } from '../shared/command-result.js';
import {
  addCommonOptions,
  isInteractive,
  mergeCommonOptions,
  outputFormat,
  type CommonCliOptions,
} from '../shared/cli-options.js';
import { requiredMetricInput, type RegisterMetricCommandsOptions } from './registration-support.js';

type TestOptions = CommonCliOptions & { fixture?: string; fromJson?: string };

/** Registers metric evaluation against a strict local fixture. */
const registerMetricTestCommand = (
  metric: Command,
  context: RegisterMetricCommandsOptions,
): void => {
  const testCommand = addCommonOptions(
    metric.command('test').description('Test one metric against a local fixture.'),
  )
    .argument('[metric-id]', 'metric id')
    .option('--fixture <path|->', 'strict local metric-test fixture')
    .option('--from-json <path|->', 'read one metric.test request')
    .action(async (metricId: string | undefined, raw: TestOptions, command: Command) => {
      const options = mergeCommonOptions(raw, command, context.program);
      if (
        options.fromJson !== undefined &&
        (metricId !== undefined || options.fixture !== undefined)
      ) {
        throw new AttestCliError('cli_usage', 'Metric test input sources overlap.', {
          path: '--from-json',
        });
      }
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request =
        options.fromJson === undefined
          ? validateMetricCommandRequest('metric.test', {
              schema: COMMAND_REQUEST_SCHEMA_ID,
              command: 'metric.test',
              metric_id: await requiredMetricInput(
                metricId,
                '<metric-id>',
                'Metric id: ',
                interactive,
                context,
              ),
              fixture: await requiredMetricInput(
                options.fixture,
                '--fixture',
                'Fixture path or -: ',
                interactive,
                context,
              ),
            })
          : await readMetricCommandRequest(
              'metric.test',
              options.fromJson,
              context.workingDirectory,
              context.interaction.readStdin,
            );
      if (options.fromJson === '-' && request.fixture === '-') {
        throw new AttestCliError(
          'cli_usage',
          'One stdin stream cannot contain two metric inputs.',
          {
            path: '--from-json',
          },
        );
      }

      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try {
        const result = await runMetricTestCommand({
          fixture: request.fixture,
          metricId: request.metric_id,
          project: options.project,
          readStdin: context.interaction.readStdin,
          signal: controller.signal,
          workingDirectory: context.workingDirectory,
        });
        context.io.output(renderCommandResult('metric.test', outputFormat(options), result));
      } finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
      }
    });

  setCliCommandHelpMetadata(testCommand, {
    examples: [
      'attest metric test exact --fixture ./fixtures/case-result.json --output json',
      'attest metric test exact --fixture - --output json',
      'attest metric test --from-json ./metric-test.json --output json',
    ],
    requestSchema: COMMAND_REQUEST_SCHEMA_ID,
    options: {
      output: { implies: ['non-interactive'] },
      fixture: { conflicts: ['from-json'] },
      'from-json': { conflicts: ['metric-id', 'fixture'], implies: ['non-interactive'] },
    },
  });
};

export { registerMetricTestCommand };
