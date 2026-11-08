import * as Effect from 'effect/Effect';
import type { TestAuthoringCommand } from '@attest/local/test';

import { AttestCliError } from '../../../errors/cli-error.js';
import { promptContext, type MutationCliOptions } from '../../shared/cli-options.js';
import type { CommandContext } from '../../shared/command-context.js';
import { ask } from '../../shared/required-input.js';

type RemovalConfirmation = {
  request: TestAuthoringCommand;
  /** Names the resource in the question and the declined message, such as `test smoke`. */
  label: string;
  options: MutationCliOptions;
  context: CommandContext;
};

/**
 * Asks before removing a test, case, or dataset. Returns false when the user declines; without a
 * terminal the removal needs `--yes`.
 */
const confirmRemoval = Effect.fn('confirmRemoval')(function* ({
  request,
  label,
  options,
  context,
}: RemovalConfirmation) {
  if (request.dry_run === true || request.yes === true) return true;

  const prompt = promptContext(options, context.interaction, context.signal);

  if (!prompt.interactive) {
    return yield* new AttestCliError(
      'cli_missing_input',
      'Destructive removal requires confirmation.',
      {
        path: '--yes',
        hint: 'Pass --yes or set `yes: true` in the command request.',
      },
    );
  }

  const answer = (yield* ask(prompt, `Remove ${label}? [y/N]: `)).trim().toLowerCase();

  if (answer === 'y' || answer === 'yes') return true;
  context.io.output(`No changes made; ${label} was not removed.`);

  return false;
});

export { confirmRemoval };
