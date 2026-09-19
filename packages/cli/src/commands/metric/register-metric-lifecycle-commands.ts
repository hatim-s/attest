import type { Command } from 'commander';

import {
  addMutationOptions,
  isInteractive,
  mergeCommonOptions,
  type MutationCliOptions,
} from '../shared/cli-options.js';
import {
  assertNoMetricRequestOverlap,
  markMetricMutationHelp,
  metricMutationFields,
  readOrBuildMetricMutation,
  requiredMetricInput,
  runMetricMutation,
  type RegisterMetricCommandsOptions,
} from './registration-support.js';

type RemoveOptions = MutationCliOptions & { detach?: boolean };

/** Registers metric rename and removal commands that update references atomically. */
const registerMetricLifecycleCommands = (
  metric: Command,
  context: RegisterMetricCommandsOptions,
): void => {
  const rename = addMutationOptions(
    metric.command('rename').description('Rename metric references atomically.'),
  )
    .argument('[metric-id]', 'current metric id')
    .argument('[new-id]', 'new metric id')
    .action(
      async (
        metricId: string | undefined,
        newId: string | undefined,
        raw: MutationCliOptions,
        command: Command,
      ) => {
        const options = mergeCommonOptions(raw, command, context.program);
        assertNoMetricRequestOverlap(options, { 'metric-id': metricId, 'new-id': newId });
        const interactive = isInteractive(options, context.interaction, options.fromJson);
        const request = await readOrBuildMetricMutation(
          'metric.rename',
          options,
          context,
          async () => ({
            ...metricMutationFields('metric.rename', options),
            metric_id: await requiredMetricInput(
              metricId,
              '<metric-id>',
              'Metric id: ',
              interactive,
              context,
            ),
            new_id: await requiredMetricInput(
              newId,
              '<new-id>',
              'New metric id: ',
              interactive,
              context,
            ),
          }),
        );
        await runMetricMutation(request, options, interactive, context);
      },
    );
  markMetricMutationHelp(
    rename,
    ['attest metric rename correct correctness'],
    ['metric-id', 'new-id'],
  );

  const remove = addMutationOptions(
    metric.command('remove').description('Remove one metric resource.'),
  )
    .argument('[metric-id]', 'metric id')
    .option('--detach', 'remove every test and case reference atomically')
    .action(async (metricId: string | undefined, raw: RemoveOptions, command: Command) => {
      const options = mergeCommonOptions(raw, command, context.program);
      assertNoMetricRequestOverlap(options, { 'metric-id': metricId, detach: options.detach });
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await readOrBuildMetricMutation(
        'metric.remove',
        options,
        context,
        async () => ({
          ...metricMutationFields('metric.remove', options),
          metric_id: await requiredMetricInput(
            metricId,
            '<metric-id>',
            'Metric id: ',
            interactive,
            context,
          ),
          ...(options.detach === undefined ? {} : { detach: options.detach }),
        }),
      );
      await runMetricMutation(request, options, interactive, context);
    });
  markMetricMutationHelp(
    remove,
    ['attest metric remove correct --dry-run'],
    ['metric-id', 'detach'],
  );
};

export { registerMetricLifecycleCommands };
