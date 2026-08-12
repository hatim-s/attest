import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  COMMAND_REQUEST_SCHEMA_ID,
  commandRequestSchema,
  type CommandRequest,
  type JsonValue,
} from '@attest/contracts';

import { AttestCliError } from '../../../errors/index.js';
import type { ReadInput } from '../../agent/agent-request.js';

const requestDiagnostics = (
  issues: readonly { message: string; path: PropertyKey[] }[],
): JsonValue => issues.map(({ message, path }) => ({ message, path: `/${path.join('/')}` }));

/** Reads one local UTF-8 input without reflecting its potentially sensitive contents. */
const readTextSource = async (
  source: string,
  path: string,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<string> => {
  try {
    return source === '-'
      ? await readStdin()
      : await readFile(resolve(workingDirectory, source), 'utf8');
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'Could not read the requested metric input.', {
      path,
      hint: 'Pass a readable UTF-8 file or `-` for stdin.',
      cause: error,
    });
  }
};

const parseJson = (text: string, path: string, hint: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', `${path} is not valid JSON.`, {
      path,
      hint,
      cause: error,
    });
  }
};

/** Validates a request from flags or `--from-json` through the same strict published union. */
const validateMetricCommandRequest = <TCommand extends CommandRequest['command']>(
  command: TCommand,
  value: unknown,
): Extract<CommandRequest, { command: TCommand }> => {
  const parsed = commandRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'The metric command request does not match its schema.', {
      hint: `Run \`attest help ${command.replaceAll('.', ' ')} --output json\` and repair the input.`,
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  if (parsed.data.command !== command) {
    throw new AttestCliError('cli_usage', 'The command request targets another command.', {
      path: '/command',
      hint: `Set \`command\` to \`${command}\`.`,
    });
  }
  return parsed.data as Extract<CommandRequest, { command: TCommand }>;
};

/** Reads one strict metric command request without allowing a second stdin consumer. */
const readMetricCommandRequest = async <TCommand extends CommandRequest['command']>(
  command: TCommand,
  source: string,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<Extract<CommandRequest, { command: TCommand }>> => {
  const text = await readTextSource(source, '--from-json', workingDirectory, readStdin);
  return validateMetricCommandRequest(
    command,
    parseJson(text, '--from-json', `Provide one ${COMMAND_REQUEST_SCHEMA_ID} document.`),
  );
};

export {
  parseJson,
  readMetricCommandRequest,
  readTextSource,
  requestDiagnostics,
  validateMetricCommandRequest,
};
