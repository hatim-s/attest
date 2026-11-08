import * as Effect from 'effect/Effect';
import { AttestCliError } from '../../errors/cli-error.js';
import { ask, type PromptContext } from '../shared/required-input.js';

/** Returns a flag value, or asks with a documented default. */
const promptDefault = Effect.fn('promptDefault')(function* (
  value: string | undefined,
  question: string,
  fallback: string,
  context: PromptContext,
): Effect.fn.Return<string, Error> {
  if (value?.trim()) return value.trim();

  if (!context.interactive) return fallback;

  return (yield* ask(context, `${question} [${fallback}]: `)).trim() || fallback;
});

/** Returns a flag value, or asks and treats an empty answer as no value. */
const promptOptional = Effect.fn('promptOptional')(function* (
  value: string | undefined,
  question: string,
  context: PromptContext,
): Effect.fn.Return<string | undefined, Error> {
  if (value?.trim()) return value.trim();

  if (!context.interactive) return undefined;

  const answer = (yield* ask(context, `${question} [none]: `)).trim();

  return answer.length === 0 ? undefined : answer;
});

/** Asks with a default and accepts only one of the listed answers. */
const promptChoice = Effect.fn('promptChoice')(function* <const Choice extends string>(
  question: string,
  choices: readonly [Choice, ...Choice[]],
  fallback: Choice,
  path: string,
  context: PromptContext,
): Effect.fn.Return<Choice, Error> {
  const answer = yield* promptDefault(undefined, question, fallback, context);
  const choice = choices.find((candidate) => candidate === answer);

  if (choice !== undefined) return choice;

  return yield* new AttestCliError(
    'cli_usage',
    `${question} must be one of ${choices.join(', ')}.`,
    {
      path,
    },
  );
});

/** Splits a comma-separated answer, returning undefined when nothing was entered. */
const commaSeparated = (value: string): string[] | undefined => {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return entries.length === 0 ? undefined : entries;
};

export { commaSeparated, promptChoice, promptDefault, promptOptional };
