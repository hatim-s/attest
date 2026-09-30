import type { CommandRequest } from '@attest/contracts';
import { readCommandRequest, validateCommandRequest } from '@attest/local/agent';
import type { Command } from 'commander';

import { AttestCliError } from '../../errors/cli-error.js';
import { authoredFieldValues } from './cli-options.js';
import type { CommandContext } from './command-context.js';

type CommandRequestFor<TCommand extends CommandRequest['command']> = Extract<
  CommandRequest,
  { command: TCommand }
>;

type RequestSourceFlags = {
  dryRun?: boolean;
  fromJson?: string;
  ifProjectHash?: string;
  yes?: boolean;
};

type ReadRequestOptions<TCommand extends CommandRequest['command']> = {
  command: TCommand;
  context: Pick<CommandContext, 'interaction' | 'workingDirectory'>;
  /** The parsed Commander leaf, whose authored flags and arguments must not overlap the request. */
  leaf: Command;
  options: RequestSourceFlags & { fromJson: string };
};

type ReadOrBuildRequestOptions<TCommand extends CommandRequest['command']> = Omit<
  ReadRequestOptions<TCommand>,
  'options'
> & {
  build: () => Promise<unknown>;
  options: RequestSourceFlags;
};

const supplied = (value: unknown): boolean =>
  value !== undefined && value !== false && (!Array.isArray(value) || value.length > 0);

/**
 * Rejects flags and arguments next to `--from-json`. A request document is complete, so any
 * flag beside it would be silently ignored.
 */
const assertNoRequestOverlap = (
  options: RequestSourceFlags,
  fields: Readonly<Record<string, unknown>>,
): void => {
  if (options.fromJson === undefined) return;
  const conflicts = Object.entries({
    ...fields,
    'dry-run': options.dryRun,
    'if-project-hash': options.ifProjectHash,
    yes: options.yes,
  })
    .filter(([, value]) => supplied(value))
    .map(([name]) => name)
    .sort();
  if (conflicts.length === 0) return;
  throw new AttestCliError('cli_usage', 'Command request sources overlap.', {
    path: '--from-json',
    hint: 'Pass command values through either flags and arguments or --from-json, not both.',
    details: { conflicting_fields: conflicts },
  });
};

/** True when the request names stdin as its import source or fixture. */
const requestReadsStdin = (request: CommandRequest): boolean =>
  ('source' in request && request.source === '-') ||
  ('fixture' in request && request.fixture === '-');

/** Reads the `--from-json` request after rejecting authored flags and a doubly used stdin. */
const readJsonRequest = async <TCommand extends CommandRequest['command']>({
  command,
  context,
  leaf,
  options,
}: ReadRequestOptions<TCommand>): Promise<CommandRequestFor<TCommand>> => {
  assertNoRequestOverlap(options, authoredFieldValues(leaf));
  const request = await readCommandRequest(command, options.fromJson, {
    readStdin: context.interaction.readStdin,
    workingDirectory: context.workingDirectory,
  });
  if (options.fromJson === '-' && requestReadsStdin(request)) {
    throw new AttestCliError(
      'cli_usage',
      'The command request and its source cannot share stdin.',
      {
        path: '--from-json',
        hint: 'Put either the command request or the source it reads in a file.',
      },
    );
  }
  return request;
};

/**
 * Returns the `--from-json` request, or validates the one built from flags, through the same
 * published schema. Both routes reach the local command with one shape.
 */
const readOrBuildRequest = async <TCommand extends CommandRequest['command']>({
  build,
  options,
  ...read
}: ReadOrBuildRequestOptions<TCommand>): Promise<CommandRequestFor<TCommand>> => {
  const { fromJson } = options;
  if (fromJson === undefined) return validateCommandRequest(read.command, await build());
  return readJsonRequest({ ...read, options: { ...options, fromJson } });
};

export { assertNoRequestOverlap, readJsonRequest, readOrBuildRequest };
