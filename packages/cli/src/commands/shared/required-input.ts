import * as Effect from 'effect/Effect';
import { AttestCliError } from '../../errors/cli-error.js';
import type { CliPrompt } from './cli-interaction.js';

/** Whether a command may ask, how it asks, and the command signal that cancels a pending question. */
type PromptContext = {
  interactive: boolean;
  prompt: CliPrompt;
  signal: AbortSignal;
};

type RequiredInput = {
  /** Flag or argument named in the missing-input error, such as `--agent` or `<test-id>`. */
  path: string;
  question: string;
};

const cancelled = (): AttestCliError => new AttestCliError('cancelled', 'Command cancelled.');

/**
 * Asks one question and closes it when either the command or its fiber is cancelled. A rejection
 * after the command signal aborted is cancellation; any other rejection is a defect.
 */
const ask = Effect.fn('ask')(function* (context: PromptContext, question: string) {
  const { prompt, signal } = context;

  if (signal.aborted) return yield* cancelled();

  const answer = Effect.tryPromise({
    try: (interruption) => prompt(question, { signal: interruption }),
    catch: (cause) => cause,
  }).pipe(Effect.catch((cause) => (signal.aborted ? Effect.fail(cancelled()) : Effect.die(cause))));

  const cancellation = Effect.callback<never, AttestCliError>((resume) => {
    const abort = () => resume(Effect.fail(cancelled()));
    signal.addEventListener('abort', abort, { once: true });

    if (signal.aborted) abort();

    return Effect.sync(() => signal.removeEventListener('abort', abort));
  });

  return yield* Effect.raceFirst(answer, cancellation);
});

/** Returns the flag value, else asks for it on a terminal, else reports it as missing input. */
const requiredInput = Effect.fn('requiredInput')(function* (
  value: string | undefined,
  input: RequiredInput,
  context: PromptContext,
) {
  if (context.signal.aborted) return yield* cancelled();
  const provided = value?.trim();

  if (provided !== undefined && provided.length > 0) return provided;

  if (context.interactive) {
    const answer = (yield* ask(context, input.question)).trim();

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

export { ask, requiredInput, type PromptContext };
