import {
  COMMAND_REQUEST_SCHEMA_ID,
  commandRequestSchema,
  type CommandRequest,
} from '@attest/contracts';

import { LocalError } from '../../errors/index.js';
import { schemaIssueDiagnostics } from '../../internal/schema-issue-diagnostics.js';
import { parseJsonText, readSourceText } from '../../internal/source-text.js';

type CommandRequestFor<TCommand extends CommandRequest['command']> = Extract<
  CommandRequest,
  { command: TCommand }
>;

type ReadCommandRequestOptions = {
  readStdin: () => Promise<string>;
  workingDirectory: string;
};

const parseCommandRequest = <TCommand extends CommandRequest['command']>(
  command: TCommand,
  value: unknown,
  path: string | undefined,
): CommandRequestFor<TCommand> => {
  const parsed = commandRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new LocalError('cli_usage', 'The command request does not match its schema.', {
      path,
      hint: `Run \`attest help ${command.replaceAll('.', ' ')} --output json\` and repair the input.`,
      details: { diagnostics: schemaIssueDiagnostics(parsed.error.issues) },
    });
  }
  if (parsed.data.command !== command) {
    throw new LocalError('cli_usage', 'The command request targets another command.', {
      path: '/command',
      hint: `Set \`command\` to \`${command}\`.`,
    });
  }
  return parsed.data as CommandRequestFor<TCommand>;
};

/**
 * Validates a request built from CLI flags through the same published schema as `--from-json`,
 * so both input routes reach the command with one shape.
 */
const validateCommandRequest = <TCommand extends CommandRequest['command']>(
  command: TCommand,
  value: unknown,
): CommandRequestFor<TCommand> => parseCommandRequest(command, value, undefined);

/** Reads one `--from-json` request document from a file or stdin and validates it. */
const readCommandRequest = async <TCommand extends CommandRequest['command']>(
  command: TCommand,
  source: string,
  options: ReadCommandRequestOptions,
): Promise<CommandRequestFor<TCommand>> => {
  const text = await readSourceText(source, { ...options, path: '--from-json' });
  const value = parseJsonText(text, {
    path: '--from-json',
    hint: `Provide one ${COMMAND_REQUEST_SCHEMA_ID} ${command} document.`,
  });
  return parseCommandRequest(command, value, '--from-json');
};

export { readCommandRequest, validateCommandRequest };
