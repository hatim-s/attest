import { runMetricMutationCommand, type MetricAuthoringRequest } from '@attest/local/metric';

import { outputFormat, type MutationCliOptions } from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';
import { renderCommandResult } from '../shared/command-result.js';

/** Runs one metric mutation through local and prints its result. */
const runMetricMutation = async (
  request: MetricAuthoringRequest,
  options: MutationCliOptions,
  interactive: boolean,
  context: CommandContext,
): Promise<void> => {
  const result = await runMetricMutationCommand({
    interactive,
    project: options.project,
    prompt: context.interaction.prompt,
    readStdin: context.interaction.readStdin,
    request,
    workingDirectory: context.workingDirectory,
  });
  context.io.output(renderCommandResult(request.command, outputFormat(options), result));
};

export { runMetricMutation };
