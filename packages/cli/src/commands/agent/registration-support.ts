import { COMMAND_REQUEST_SCHEMA_ID } from '@attest/contracts';
import type { Command } from 'commander';

import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import type { CliIo } from '../../run-cli.js';
import type { CliInteraction } from '../shared/cli-interaction.js';
import type { MutationCliOptions } from '../shared/cli-options.js';

type RegisterAgentCommandsOptions = {
  interaction: CliInteraction;
  io: CliIo;
  program: Command;
  workingDirectory: string;
};

const REPEATABLE_AGENT_OPTIONS = new Set([
  'acknowledgement-value',
  'env',
  'header-env',
  'map-body',
  'poll-failure',
  'poll-success',
  'query-env',
  'terminal-value',
]);

/** Maps shared CLI mutation flags to the local application command boundary. */
const mutationArguments = (options: MutationCliOptions, context: RegisterAgentCommandsOptions) => ({
  dryRun: options.dryRun,
  expectedProjectHash: options.ifProjectHash,
  fromJson: options.fromJson,
  project: options.project,
  readStdin: context.interaction.readStdin,
  workingDirectory: context.workingDirectory,
  yes: options.yes,
});

/** Records request-source conflicts and repeatability for an agent mutation command. */
const markAgentMutationHelp = (
  command: Command,
  examples: string[],
  extraConflicts: Readonly<Record<string, string[]>>,
  extraImplies: Readonly<Record<string, string[]>> = {},
): void => {
  setCliCommandHelpMetadata(command, {
    examples,
    requestSchema: COMMAND_REQUEST_SCHEMA_ID,
    options: {
      output: { implies: ['non-interactive'] },
      'from-json': {
        conflicts: ['dry-run', 'if-project-hash', 'yes', ...Object.keys(extraConflicts)],
        implies: ['non-interactive'],
      },
      ...Object.fromEntries(
        Object.entries(extraConflicts).map(([name, conflicts]) => [
          name,
          {
            conflicts: ['from-json', ...conflicts],
            ...(extraImplies[name] === undefined ? {} : { implies: extraImplies[name] }),
            ...(REPEATABLE_AGENT_OPTIONS.has(name) ? { repeatable: true } : {}),
          },
        ]),
      ),
    },
  });
};

export { markAgentMutationHelp, mutationArguments, type RegisterAgentCommandsOptions };
