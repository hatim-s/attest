import * as Effect from 'effect/Effect';
import { runMetricMutationCommand, type MetricAuthoringRequest } from '@attest/local/metric';

import { outputFormat, promptContext, type MutationCliOptions } from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';
import { renderCommandResult } from '../shared/command-result.js';
import { localPrompt } from '../shared/required-input.js';

/** Runs one metric mutation through local and prints its result. */
const runMetricMutation = (
  request: MetricAuthoringRequest,
  options: MutationCliOptions,
  context: CommandContext,
) =>
  Effect.gen(function* () {
    const prompt = promptContext(options, context.interaction, context.signal);

    const result = yield* runMetricMutationCommand({
      interactive: prompt.interactive,
      project: options.project,
      prompt: localPrompt(prompt),
      readStdin: context.interaction.readStdin,
      request,
      workingDirectory: context.workingDirectory,
    });

    context.io.output(renderCommandResult(request.command, outputFormat(options), result));
  });

export { runMetricMutation };
