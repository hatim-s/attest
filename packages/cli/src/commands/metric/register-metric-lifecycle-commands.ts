import * as Effect from 'effect/Effect';
import type { CommandRequest } from '@attest/contracts';
import type { Command } from 'commander';

import { setMutationHelp } from '../../help/command-help.js';
import {
  addMutationOptions,
  mutationRequestFields,
  type MutationCliOptions,
  promptContext,
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
      (
        metricId: string | undefined,
        newId: string | undefined,
        options: MutationCliOptions,
        leaf: Command,
      ) =>
        context.submit(
          Effect.gen(function* () {
            const prompt = promptContext(options, context.interaction, context.signal);
            const { interactive } = prompt;

            const request = yield* readOrBuildRequest({
              command: 'metric.rename',
              context,
              leaf,
              options,
              build: () =>
                Effect.gen(function* () {
                  return {
                    ...mutationRequestFields('metric.rename', options),
                    metric_id: yield* requiredInput(
                      metricId,
                      { path: '<metric-id>', question: 'Metric id: ' },
                      prompt,
                    ),
                    new_id: yield* requiredInput(
                      newId,
                      { path: '<new-id>', question: 'New metric id: ' },
                      prompt,
                    ),
                  };
                }),
            });

            yield* runMetricMutation(request, options, interactive, context);
          }),
        ),
    );

  setMutationHelp(rename, { examples: ['attest metric rename correct correctness'] });

  const remove = addMutationOptions(
    metric.command('remove').description('Remove one metric resource.'),
  )
    .argument('[metric-id]', 'metric id')
    .option('--detach', 'remove every test and case reference atomically')
    .action((metricId: string | undefined, options: RemoveOptions, leaf: Command) =>
      context.submit(
        Effect.gen(function* () {
          const prompt = promptContext(options, context.interaction, context.signal);
          const { interactive } = prompt;

          const request = yield* readOrBuildRequest({
            command: 'metric.remove',
            context,
            leaf,
            options,
            build: () =>
              Effect.gen(function* () {
                let request: Extract<CommandRequest, { command: 'metric.remove' }> = {
                  ...mutationRequestFields('metric.remove', options),
                  metric_id: yield* requiredInput(
                    metricId,
                    { path: '<metric-id>', question: 'Metric id: ' },
                    prompt,
                  ),
                };

                if (options.detach !== undefined) {
                  request = { ...request, detach: options.detach };
                }

                return request;
              }),
          });

          yield* runMetricMutation(request, options, interactive, context);
        }),
      ),
    );

  setMutationHelp(remove, { examples: ['attest metric remove correct --dry-run'] });
};

export { registerMetricLifecycleCommands };
