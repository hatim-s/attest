import { AttestCliError } from '../../errors/index.js';
import type { CliInteraction } from '../shared/cli-interaction.js';

type Prompt = CliInteraction['prompt'];

/** Guided agent questions share the command's interactivity and optional cancellation signal. */
type AgentPromptContext = {
  interactive: boolean;
  prompt: Prompt;
  signal?: AbortSignal;
};

const cancelled = (): AttestCliError => new AttestCliError('cancelled', 'Command cancelled.');

/** Asks one question and rejects as soon as the command is cancelled. */
const promptWithSignal = async (
  prompt: Prompt,
  question: string,
  signal?: AbortSignal,
): Promise<string> => {
  if (signal === undefined) return prompt(question);
  if (signal.aborted) throw cancelled();
  return new Promise<string>((resolvePrompt, rejectPrompt) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      action();
    };
    const cancel = (): void => finish(() => rejectPrompt(cancelled()));
    const promptFailure = (error: unknown): Error => {
      if (signal.aborted) return cancelled();
      if (error instanceof Error && error.name === 'AbortError') return cancelled();
      if (error instanceof Error) return error;
      return new Error('Prompt failed with a non-error rejection.', { cause: error });
    };
    signal.addEventListener('abort', cancel, { once: true });
    // The signal closes the real readline question; the outer race also supports injected prompts.
    void prompt(question, { signal }).then(
      (answer) => finish(() => resolvePrompt(answer)),
      (error: unknown) => finish(() => rejectPrompt(promptFailure(error))),
    );
  });
};

/** Returns a flag value, or asks for it interactively, or reports it as missing input. */
const promptRequired = async (
  value: string | undefined,
  label: string,
  path: string,
  context: AgentPromptContext,
): Promise<string> => {
  if (context.signal?.aborted === true) throw cancelled();
  if (value?.trim()) return value.trim();
  if (context.interactive) {
    const answer = (await promptWithSignal(context.prompt, `${label}: `, context.signal)).trim();
    if (answer.length > 0) return answer;
  }
  throw new AttestCliError('cli_missing_input', `${label} is required.`, {
    path,
    hint: `Pass ${path} or a complete \`--from-json\` request.`,
  });
};

/** Returns a flag value, or asks with a documented default. */
const promptDefault = async (
  value: string | undefined,
  question: string,
  fallback: string,
  context: AgentPromptContext,
): Promise<string> => {
  if (value?.trim()) return value.trim();
  if (!context.interactive) return fallback;
  return (await context.prompt(`${question} [${fallback}]: `)).trim() || fallback;
};

/** Returns a flag value, or asks and treats an empty answer as no value. */
const promptOptional = async (
  value: string | undefined,
  question: string,
  context: AgentPromptContext,
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
  context: AgentPromptContext,
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

export {
  commaSeparated,
  promptChoice,
  promptDefault,
  promptOptional,
  promptRequired,
  type AgentPromptContext,
};
