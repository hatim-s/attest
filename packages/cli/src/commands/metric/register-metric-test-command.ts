import { COMMAND_REQUEST_SCHEMA_ID } from '@attest/contracts';
import { runMetricTestCommand } from '@attest/local/metric';
import type { Command } from 'commander';

import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import {
  addCommonOptions,
  isInteractive,
  outputFormat,
  type CommonCliOptions,
} from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';
import { readOrBuildRequest } from '../shared/command-request.js';
import { renderCommandResult } from '../shared/command-result.js';
import { withProcessSignals } from '../shared/process-signals.js';
import { requiredInput } from '../shared/required-input.js';

type TestOptions = CommonCliOptions & { fixture?: string; fromJson?: string };

/** Registers metric evaluation against a strict local fixture. */
const registerMetricTestCommand = (metric: Command, context: CommandContext): void => {
  const testCommand = addCommonOptions(
    metric.command('test').description('Test one metric against a local fixture.'),
  )
    .argument('[metric-id]', 'metric id')
    .option('--fixture <path|->', 'strict local metric-test fixture')
    .option('--from-json <path|->', 'read one metric.test request')
    .action(async (metricId: string | undefined, options: TestOptions, leaf: Command) => {
      const prompt = {
        interactive: isInteractive(options, context.interaction, options.fromJson),
        prompt: context.interaction.prompt,
      };
      const request = await readOrBuildRequest({
        command: 'metric.test',
        context,
        leaf,
        options,
        build: async () => ({
          schema: COMMAND_REQUEST_SCHEMA_ID,
          command: 'metric.test',
          metric_id: await requiredInput(
            metricId,
            { path: '<metric-id>', question: 'Metric id: ' },
            prompt,
          ),
          fixture: await requiredInput(
            options.fixture,
            { path: '--fixture', question: 'Fixture path or -: ' },
            prompt,
          ),
        }),
      });
      const result = await withProcessSignals((signal) =>
        runMetricTestCommand({
          fixture: request.fixture,
          metricId: request.metric_id,
          project: options.project,
          readStdin: context.interaction.readStdin,
          signal,
          workingDirectory: context.workingDirectory,
        }),
      );
      context.io.output(renderCommandResult('metric.test', outputFormat(options), result));
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
