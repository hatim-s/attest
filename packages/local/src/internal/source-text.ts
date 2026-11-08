import { parseWithSchemaSync } from '@attest/contracts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

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
const readSourceText = Effect.fn('readSourceText')(function* (
  source: string,
  options: ReadSourceTextOptions,
) {
  return yield* Effect.tryPromise({
    try: () =>
      source === '-'
        ? options.readStdin()
        : readFile(resolve(options.workingDirectory, source), 'utf8'),
    catch: (cause) =>
      new LocalError('cli_usage', `Could not read the ${options.path} input.`, {
        path: options.path,
        hint: 'Pass a readable UTF-8 file or `-` for stdin.',
        cause,
      }),
  });
});

/**
 * Parses one JSON document. The synchronous `JSON.parse` failure maps once to a LocalError
 * that never echoes the text, because the text may hold secrets.
 */
const parseJsonText = Effect.fn('parseJsonText')(function* (
  text: string,
  options: ParseJsonTextOptions,
) {
  return yield* Effect.try({
    try: () => parseWithSchemaSync(Schema.Json, JSON.parse(text)),
    catch: (cause) =>
      new LocalError('cli_usage', `${options.path} is not valid JSON.`, {
        path: options.path,
        hint: options.hint ?? 'Provide exactly one valid JSON document.',
        cause,
      }),
  });
});

export { parseJsonText, readSourceText };
