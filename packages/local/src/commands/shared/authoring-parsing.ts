import { argvSchema, parseWithSchema } from '@attest/contracts';
import * as Effect from 'effect/Effect';

import { LocalError } from '../../errors/index.js';
import { parseJsonText } from '../../internal/source-text.js';

/** Parses an unambiguous JSON argv array. */
const parseArgvJson = Effect.fn('parseArgvJson')(function* (value: string) {
  const parsed = yield* parseJsonText(value, {
    path: '--argv-json',
    hint: 'Pass a JSON array of strings.',
  });

  const argv = parseWithSchema(argvSchema, parsed);

  if (!argv.ok) {
    return yield* new LocalError('cli_usage', '`--argv-json` must be a non-empty string array.', {
      path: '--argv-json',
      hint: 'Pass a JSON array containing at least one string.',
    });
  }

  return argv.value;
});

/** Parses a positive duration expressed as milliseconds, seconds, or minutes. */
const parseDuration = Effect.fn('parseDuration')(function* (value: string, path: string) {
  const match = /^(\d+)(ms|s|m)$/u.exec(value);
  const amount = match?.[1] === undefined ? 0 : Number(match[1]);
  const unit = match?.[2];
  const multiplier = unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  const milliseconds = amount * multiplier;

  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    return yield* new LocalError('cli_usage', 'Duration must be a positive value.', {
      path,
      hint: 'Use an integer followed by ms, s, or m, such as `60s`.',
    });
  }

  return milliseconds;
});

export { parseArgvJson, parseDuration };
