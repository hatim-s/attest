import { AttestCliError } from '../../errors/cli-error.js';
import type { CliPrompt } from './cli-interaction.js';

/** Whether a command may ask, how it asks, and the signal that cancels a pending question. */
type PromptContext = {
  interactive: boolean;
  prompt: CliPrompt;
  signal?: AbortSignal;
};

type RequiredInput = {
  /** Flag or argument named in the missing-input error, such as `--agent` or `<test-id>`. */
  path: string;
  question: string;
};

const cancelled = (): AttestCliError => new AttestCliError('cancelled', 'Command cancelled.');

/** Asks one question and rejects as soon as the command is cancelled. */
const promptWithSignal = async (
  prompt: CliPrompt,
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
    // The signal closes a real readline question; the race also covers prompts that ignore it.
    void prompt(question, { signal }).then(
      (answer) => finish(() => resolvePrompt(answer)),
      (error: unknown) => finish(() => rejectPrompt(promptFailure(error))),
    );
  });
};

/** Returns the flag value, else asks for it on a terminal, else reports it as missing input. */
const requiredInput = async (
  value: string | undefined,
  input: RequiredInput,
  context: PromptContext,
): Promise<string> => {
  if (context.signal?.aborted === true) throw cancelled();
  const provided = value?.trim();
  if (provided !== undefined && provided.length > 0) return provided;
  if (context.interactive) {
    const answer = (await promptWithSignal(context.prompt, input.question, context.signal)).trim();
    if (answer.length > 0) return answer;
  }
  throw new AttestCliError('cli_missing_input', `Required input ${input.path} is missing.`, {
    path: input.path,
    hint: `Pass ${input.path} or provide it in a complete --from-json request.`,
  });
};

export { promptWithSignal, requiredInput, type PromptContext };
