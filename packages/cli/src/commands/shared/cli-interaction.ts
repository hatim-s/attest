import { createInterface } from 'node:readline/promises';
import { text } from 'node:stream/consumers';

type CliPrompt = (question: string, options?: { signal?: AbortSignal }) => Promise<string>;

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

/** Creates the process-backed interaction used by the production CLI. */
const createDefaultCliInteraction = (): CliInteraction => ({
  ci: process.env.CI === 'true',
  inputIsTTY: process.stdin.isTTY === true,
  outputIsTTY: process.stdout.isTTY === true,
  prompt: promptOnTerminal,
  readImportStdin: () => process.stdin,
  readStdin: () => text(process.stdin),
});

export { createDefaultCliInteraction, type CliInteraction, type CliPrompt };
