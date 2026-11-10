import { runTestMutationCommand, type TestAuthoringCommand } from '@attest/local/test';

import type { MutationCliOptions } from '../../shared/cli-options.js';
import type { CommandContext } from '../../shared/command-context.js';

/** Supplies invocation dependencies for test authoring; callers own result presentation. */
const runTestMutation = (
  request: TestAuthoringCommand,
  options: MutationCliOptions,
  context: CommandContext,
  preparedImportSource?: Uint8Array,
) =>
  runTestMutationCommand({
    preparedImportSource,
    project: options.project,
    readImportStdin: context.interaction.readImportStdin,
    readStdin: context.interaction.readStdin,
    request,
    workingDirectory: context.workingDirectory,
  });

export { runTestMutation };
