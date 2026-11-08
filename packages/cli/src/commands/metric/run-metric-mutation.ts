import * as Effect from 'effect/Effect';
import { runMetricMutationCommand, type MetricAuthoringRequest } from '@attest/local/metric';

import { outputFormat, type MutationCliOptions } from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';
import { renderCommandResult } from '../shared/command-result.js';
import { localPrompt, type PromptContext } from '../shared/required-input.js';

type MetricMutationInput = {
  request: MetricAuthoringRequest;
  options: MutationCliOptions;
  /** The caller's prompt context, so the mutation asks under the same rules as its guided input. */
  prompt: PromptContext;
  context: CommandContext;
};

/** Runs one metric mutation through local and prints its result. */
const runMetricMutation = ({ request, options, prompt, context }: MetricMutationInput) =>
  Effect.gen(function* () {
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
