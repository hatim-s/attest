import { createInterface } from 'node:readline/promises';

type CliInteraction = {
  ci: boolean;
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  prompt: (question: string, options?: { signal?: AbortSignal }) => Promise<string>;
  readImportStdin: () => AsyncIterable<string | Uint8Array>;
  readStdin: () => Promise<string>;
};

/** Reads stdin to completion for one non-interactive command request. */
const readStdin = async (): Promise<string> => {
  let text = '';
  for await (const chunk of process.stdin as AsyncIterable<unknown>) {
    if (typeof chunk === 'string') text += chunk;
    else if (Buffer.isBuffer(chunk)) text += chunk.toString('utf8');
  }
  return text;
};

/** Creates the process-backed interaction used by the production CLI. */
const createDefaultCliInteraction = (): CliInteraction => ({
  ci: process.env.CI === 'true',
  inputIsTTY: process.stdin.isTTY === true,
  outputIsTTY: process.stdout.isTTY === true,
  readImportStdin: () => process.stdin as AsyncIterable<Uint8Array>,
  readStdin,
  prompt: async (question: string, options?: { signal?: AbortSignal }) => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      // Bind process cancellation to readline so its terminal listeners are closed in finally.
      return options?.signal === undefined
        ? await prompt.question(question)
        : await prompt.question(question, { signal: options.signal });
    } finally {
      prompt.close();
    }
  },
});

export { createDefaultCliInteraction, type CliInteraction };
