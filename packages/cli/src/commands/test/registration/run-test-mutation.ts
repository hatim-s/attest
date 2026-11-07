import * as Effect from 'effect/Effect';
import { runTestMutationCommand, type TestAuthoringCommand } from '@attest/local/test';

import { outputFormat, type MutationCliOptions } from '../../shared/cli-options.js';
import type { CommandContext } from '../../shared/command-context.js';
import { renderCommandResult } from '../../shared/command-result.js';

/** Runs one test, case, or dataset mutation through local and prints its result. */
const runTestMutation = (
  request: TestAuthoringCommand,
  options: MutationCliOptions,
  context: CommandContext,
  preparedImportSource?: Uint8Array,
) =>
  Effect.gen(function* () {
    const result = yield* runTestMutationCommand({
      preparedImportSource,
      project: options.project,
      readImportStdin: context.interaction.readImportStdin,
      readStdin: context.interaction.readStdin,
      request,
      workingDirectory: context.workingDirectory,
    });

    context.io.output(renderCommandResult(request.command, outputFormat(options), result));
  });

export { runTestMutation };
