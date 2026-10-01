import { AttestCliError } from '../../errors/cli-error.js';
import type { PromptContext } from '../shared/required-input.js';

/** Returns a flag value, or asks with a documented default. */
const promptDefault = async (
  value: string | undefined,
  question: string,
  fallback: string,
  context: PromptContext,
): Promise<string> => {
  if (value?.trim()) return value.trim();
  if (!context.interactive) return fallback;
  return (await context.prompt(`${question} [${fallback}]: `)).trim() || fallback;
};

/** Returns a flag value, or asks and treats an empty answer as no value. */
const promptOptional = async (
  value: string | undefined,
  question: string,
  context: PromptContext,
): Promise<string | undefined> => {
  if (value?.trim()) return value.trim();
  if (!context.interactive) return undefined;
  const answer = (await context.prompt(`${question} [none]: `)).trim();
  return answer.length === 0 ? undefined : answer;
};

/** Asks with a default and accepts only one of the listed answers. */
const promptChoice = async <const Choice extends string>(
  question: string,
  choices: readonly [Choice, ...Choice[]],
  fallback: Choice,
  path: string,
  context: PromptContext,
): Promise<Choice> => {
  const answer = await promptDefault(undefined, question, fallback, context);
  const choice = choices.find((candidate) => candidate === answer);
  if (choice !== undefined) return choice;
  throw new AttestCliError('cli_usage', `${question} must be one of ${choices.join(', ')}.`, {
    path,
  });
};

/** Splits a comma-separated answer, returning undefined when nothing was entered. */
const commaSeparated = (value: string): string[] | undefined => {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length === 0 ? undefined : entries;
};

export { commaSeparated, promptChoice, promptDefault, promptOptional };
