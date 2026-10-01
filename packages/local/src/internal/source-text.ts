import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { JsonValue } from '@attest/contracts';

import { LocalError } from '../errors/index.js';

type ReadSourceTextOptions = {
  /** Flag or argument named in the error, such as `--from-json`. */
  path: string;
  readStdin: () => Promise<string>;
  workingDirectory: string;
};

type ParseJsonTextOptions = {
  hint?: string;
  path: string;
};

/**
 * Reads `-` from stdin or a file relative to the working directory. Failures name only the
 * flag: the source path and its contents can both carry secrets.
 */
const readSourceText = async (source: string, options: ReadSourceTextOptions): Promise<string> => {
  try {
    if (source === '-') return await options.readStdin();
    return await readFile(resolve(options.workingDirectory, source), 'utf8');
  } catch (error: unknown) {
    throw new LocalError('cli_usage', `Could not read the ${options.path} input.`, {
      path: options.path,
      hint: 'Pass a readable UTF-8 file or `-` for stdin.',
      cause: error,
    });
  }
};

/** Parses one JSON document; the error never echoes the text because it may hold secrets. */
const parseJsonText = (text: string, options: ParseJsonTextOptions): JsonValue => {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error: unknown) {
    throw new LocalError('cli_usage', `${options.path} is not valid JSON.`, {
      path: options.path,
      hint: options.hint ?? 'Provide exactly one valid JSON document.',
      cause: error,
    });
  }
};

export { parseJsonText, readSourceText };
