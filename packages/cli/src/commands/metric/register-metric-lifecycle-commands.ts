import type { Command } from 'commander';

import { setMutationHelp } from '../../help/command-help.js';
import {
  addMutationOptions,
  isInteractive,
  mutationRequestFields,
  type MutationCliOptions,
} from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';
import { readOrBuildRequest } from '../shared/command-request.js';
import { requiredInput } from '../shared/required-input.js';
import { runMetricMutation } from './run-metric-mutation.js';

type RemoveOptions = MutationCliOptions & { detach?: boolean };

/** Registers metric rename and removal commands that update references atomically. */
const registerMetricLifecycleCommands = (metric: Command, context: CommandContext): void => {
  const rename = addMutationOptions(
    metric.command('rename').description('Rename metric references atomically.'),
  )
    .argument('[metric-id]', 'current metric id')
    .argument('[new-id]', 'new metric id')
    .action(
      async (
        metricId: string | undefined,
        newId: string | undefined,
        options: MutationCliOptions,
        leaf: Command,
      ) => {
        const interactive = isInteractive(options, context.interaction, options.fromJson);
        const prompt = { interactive, prompt: context.interaction.prompt };
        const request = await readOrBuildRequest({
          command: 'metric.rename',
          context,
          leaf,
          options,
          build: async () => ({
            ...mutationRequestFields('metric.rename', options),
            metric_id: await requiredInput(
              metricId,
              { path: '<metric-id>', question: 'Metric id: ' },
              prompt,
            ),
            new_id: await requiredInput(
              newId,
              { path: '<new-id>', question: 'New metric id: ' },
              prompt,
            ),
          }),
        });
        await runMetricMutation(request, options, interactive, context);
      },
    );
  setMutationHelp(rename, { examples: ['attest metric rename correct correctness'] });

  const remove = addMutationOptions(
    metric.command('remove').description('Remove one metric resource.'),
  )
    .argument('[metric-id]', 'metric id')
    .option('--detach', 'remove every test and case reference atomically')
    .action(async (metricId: string | undefined, options: RemoveOptions, leaf: Command) => {
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await readOrBuildRequest({
        command: 'metric.remove',
        context,
        leaf,
        options,
        build: async () => ({
          ...mutationRequestFields('metric.remove', options),
          metric_id: await requiredInput(
            metricId,
            { path: '<metric-id>', question: 'Metric id: ' },
            { interactive, prompt: context.interaction.prompt },
          ),
          ...(options.detach === undefined ? {} : { detach: options.detach }),
        }),
      });
      await runMetricMutation(request, options, interactive, context);
    });
  setMutationHelp(remove, { examples: ['attest metric remove correct --dry-run'] });
};

export { registerMetricLifecycleCommands };
