import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  COMMAND_REQUEST_SCHEMA_VERSION,
  commandRequestSchema,
  type CommandRequest,
  type TestCase,
} from '@attest/contracts';
import { createContentCaseId } from '@attest/core';

import { AttestCliError } from '../../errors.js';
import type { JsonValue } from '../../project/canonical-project.js';

type TestCaseInput = Omit<TestCase, 'id'> & { id?: string };
type ReadTextOptions = {
  pathLabel: string;
  readStdin: () => Promise<string>;
  source: string;
  workingDirectory: string;
};

const requestDiagnostics = (
  issues: readonly { message: string; path: PropertyKey[] }[],
): JsonValue => issues.map(({ message, path }) => ({ message, path: `/${path.join('/')}` }));

/** Validates a flag- or JSON-built request through the same published command schema. */
const validateCommandRequest = <TCommand extends CommandRequest['command']>(
  command: TCommand,
  value: unknown,
): Extract<CommandRequest, { command: TCommand }> => {
  const parsed = commandRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'The command request does not match its schema.', {
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

/** Reads a request document without echoing its filesystem path or contents on failure. */
const readTextSource = async (options: ReadTextOptions): Promise<string> => {
  try {
    return options.source === '-'
      ? await options.readStdin()
      : await readFile(resolve(options.workingDirectory, options.source), 'utf8');
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'Could not read the requested input source.', {
      path: options.pathLabel,
      hint: 'Pass a readable UTF-8 file or `-` for stdin.',
      cause: error,
    });
  }
};

/** Parses one strict versioned mutation request for the expected command. */
const readCommandRequest = async <TCommand extends CommandRequest['command']>(
  command: TCommand,
  source: string,
  options: Omit<ReadTextOptions, 'pathLabel' | 'source'>,
): Promise<Extract<CommandRequest, { command: TCommand }>> => {
  const text = await readTextSource({ ...options, pathLabel: '--from-json', source });
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'The command request is not valid JSON.', {
      path: '--from-json',
      hint: `Provide one ${COMMAND_REQUEST_SCHEMA_VERSION} document.`,
      cause: error,
    });
  }
  return validateCommandRequest(command, value);
};

/** Generates the ratified move-stable id used by both single-case and bulk authoring. */
const generateCaseId = (testCase: TestCaseInput): string => createContentCaseId(testCase);

/** Parses one JSON-valued flag without reflecting sensitive authored values into diagnostics. */
const parseJsonFlag = (value: string | undefined, path: string): JsonValue | undefined => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', `${path} must contain valid JSON.`, {
      path,
      hint: 'Pass a JSON scalar, array, or object.',
      cause: error,
    });
  }
};

export {
  generateCaseId,
  parseJsonFlag,
  readCommandRequest,
  validateCommandRequest,
  type TestCaseInput,
};
