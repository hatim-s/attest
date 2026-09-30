import { COMMAND_REQUEST_SCHEMA_ID } from '@attest/contracts';
import type { Command } from 'commander';

import { AttestCliError } from '../../errors/index.js';
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

/** Builds the request fields shared by every agent mutation from the common mutation flags. */
const agentMutationFields = <Command extends string>(
  command: Command,
  options: MutationCliOptions,
) => ({
  schema: COMMAND_REQUEST_SCHEMA_ID,
  command,
  ...(options.dryRun === undefined ? {} : { dry_run: options.dryRun }),
  ...(options.ifProjectHash === undefined ? {} : { if_project_hash: options.ifProjectHash }),
  ...(options.yes === undefined ? {} : { yes: options.yes }),
});

/** Rejects flags that would be silently ignored next to a complete `--from-json` request. */
const assertNoAgentRequestOverlap = (
  options: Pick<MutationCliOptions, 'dryRun' | 'fromJson' | 'ifProjectHash' | 'yes'>,
  fields: Readonly<Record<string, unknown>>,
): void => {
  if (options.fromJson === undefined) return;
  const mutationFlags = {
    'dry-run': options.dryRun,
    'if-project-hash': options.ifProjectHash,
    yes: options.yes,
  };
  const conflicts = Object.entries({ ...fields, ...mutationFlags })
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([name]) => name)
    .sort();
  if (conflicts.length === 0) return;
  throw new AttestCliError('cli_usage', 'Command request input overlaps with CLI values.', {
    path: '--from-json',
    hint: 'Pass command values in either the request document or flags, not both.',
    details: { conflicting_fields: conflicts },
  });
};

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

export {
  agentMutationFields,
  assertNoAgentRequestOverlap,
  markAgentMutationHelp,
  type RegisterAgentCommandsOptions,
};
