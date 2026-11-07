import { createInterface } from 'node:readline/promises';
import { text } from 'node:stream/consumers';

import type { AgentImportCommandOptions } from '@attest/local/agent';

type CliPrompt = NonNullable<AgentImportCommandOptions['prompt']>;

type CliInteraction = {
  ci: boolean;
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  prompt: CliPrompt;
  readImportStdin: () => AsyncIterable<string | Uint8Array>;
  readStdin: () => Promise<string>;
};

/** Asks one readline question; the signal closes the question so its terminal listeners go too. */
const promptOnTerminal: CliPrompt = async (question, options) => {
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return await readline.question(question, { signal: options?.signal });
  } finally {
    readline.close();
  }
};

/** Closes a pending process input read when the application receives cancellation. */
const processInput = async function* (signal?: AbortSignal): AsyncIterable<Uint8Array> {
  const abort = () => process.stdin.destroy(new DOMException('Input cancelled.', 'AbortError'));

  if (signal?.aborted) throw new DOMException('Input cancelled.', 'AbortError');
  signal?.addEventListener('abort', abort, { once: true });

  try {
    yield* process.stdin;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
};

/** Creates the process-backed interaction used by the production CLI. */
const createDefaultCliInteraction = (signal?: AbortSignal): CliInteraction => ({
  ci: process.env.CI === 'true',
  inputIsTTY: process.stdin.isTTY === true,
  outputIsTTY: process.stdout.isTTY === true,
  prompt: promptOnTerminal,
  readImportStdin: () => processInput(signal),
  readStdin: () => text(processInput(signal)),
});

export { createDefaultCliInteraction, type CliInteraction, type CliPrompt };
