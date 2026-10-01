import type { TestAuthoringCommand } from '@attest/local/test';

import { AttestCliError } from '../../../errors/cli-error.js';
import { isInteractive, type MutationCliOptions } from '../../shared/cli-options.js';
import type { CommandContext } from '../../shared/command-context.js';

/**
 * Asks before removing a test, case, or dataset. Returns false when the user declines; without a
 * terminal the removal needs `--yes`.
 */
const confirmRemoval = async (
  request: TestAuthoringCommand,
  label: string,
  options: MutationCliOptions,
  context: CommandContext,
): Promise<boolean> => {
  if (request.dry_run === true || request.yes === true) return true;
  if (!isInteractive(options, context.interaction, options.fromJson)) {
    throw new AttestCliError('cli_missing_input', 'Destructive removal requires confirmation.', {
      path: '--yes',
      hint: 'Pass --yes or set `yes: true` in the command request.',
    });
  }
  const answer = (await context.interaction.prompt(`Remove ${label}? [y/N]: `))
    .trim()
    .toLowerCase();
  if (answer === 'y' || answer === 'yes') return true;
  context.io.output(`No changes made; ${label} was not removed.`);
  return false;
};

export { confirmRemoval };
