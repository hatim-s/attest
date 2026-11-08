import * as Effect from 'effect/Effect';
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

/** Asks one question and closes it when either the command or its fiber is cancelled. */
const promptWithSignal: (
  prompt: CliPrompt,
  question: string,
  signal?: AbortSignal,
) => Effect.Effect<string, Error> = Effect.fn('promptWithSignal')(function* (
  prompt: CliPrompt,
  question: string,
  signal?: AbortSignal,
): Effect.fn.Return<string, Error> {
  if (signal?.aborted) return yield* cancelled();

  const questionEffect = Effect.tryPromise({
    try: (interruption) => prompt(question, { signal: interruption }),
    catch: (cause) => {
      if (signal?.aborted || (cause instanceof Error && cause.name === 'AbortError'))
        return cancelled();

      return cause instanceof Error
        ? cause
        : new Error('Prompt failed with a non-error rejection.', { cause });
    },
  });

  if (signal === undefined) return yield* questionEffect;

  const cancellation = Effect.callback<never, AttestCliError>((resume) => {
    const abort = () => resume(cancelled());
    signal.addEventListener('abort', abort, { once: true });

    if (signal.aborted) abort();

    return Effect.sync(() => signal.removeEventListener('abort', abort));
  });

  return yield* Effect.raceFirst(questionEffect, cancellation);
});

/** Returns the flag value, else asks for it on a terminal, else reports it as missing input. */
const requiredInput = Effect.fn('requiredInput')(function* (
  value: string | undefined,
  input: RequiredInput,
  context: PromptContext,
) {
  if (context.signal?.aborted === true) return yield* cancelled();
  const provided = value?.trim();

  if (provided !== undefined && provided.length > 0) return provided;

  if (context.interactive) {
    const answer = (yield* promptWithSignal(context.prompt, input.question, context.signal)).trim();

    if (answer.length > 0) return answer;
  }

  return yield* new AttestCliError(
    'cli_missing_input',
    `Required input ${input.path} is missing.`,
    {
      path: input.path,
      hint: `Pass ${input.path} or provide it in a complete --from-json request.`,
    },
  );
});

export { promptWithSignal, requiredInput, type PromptContext };
