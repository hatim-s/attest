import * as Effect from 'effect/Effect';
import { describe, expect, it } from 'vitest';

import { runCli } from '../../../run-cli.js';
import type { CliInteraction } from '../cli-interaction.js';
import { ask } from '../required-input.js';

/** A terminal prompt that settles only when its own signal aborts, like readline. */
const pendingQuestion = (onAsk: () => void) => {
  const signals: AbortSignal[] = [];

  const prompt: CliInteraction['prompt'] = (_question, options) => {
    if (options?.signal !== undefined) signals.push(options.signal);

    return new Promise<string>((_resolve, reject) => {
      options?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('The operation was aborted.', 'AbortError')),
        { once: true },
      );
      onAsk();
    });
  };

  return { signals, prompt };
};

describe('ask', () => {
  it('aborts a pending terminal question when the command signal fires', async () => {
    const controller = new AbortController();
    const { signals, prompt } = pendingQuestion(() => controller.abort());

    const result = Effect.runPromiseExit(
      ask({ interactive: true, prompt, signal: controller.signal }, 'Question: ').pipe(Effect.flip),
    );

    await expect(result).resolves.toMatchObject({
      _tag: 'Success',
      value: { code: 'cancelled', message: 'Command cancelled.' },
    });
    expect(signals.map(({ aborted }) => aborted)).toEqual([true]);
  });
});

describe('owned command prompts', () => {
  it('closes a pending question and reports cancellation on SIGTERM', async () => {
    const errors: string[] = [];

    const { signals, prompt } = pendingQuestion(() =>
      queueMicrotask(() => process.emit('SIGTERM')),
    );

    const exitCode = await runCli(['metric', 'test'], {
      interaction: { ci: false, inputIsTTY: true, outputIsTTY: true, prompt },
      io: { error: (line) => errors.push(line), output: () => {} },
    });

    expect(signals.map(({ aborted }) => aborted)).toEqual([true]);
    expect(exitCode).toBe(130);
    expect(errors).toEqual([expect.stringContaining('cancelled: Command cancelled.')]);
  }, 5_000);

  it('reports cancellation when readline aborts the question on Ctrl+C', async () => {
    const errors: string[] = [];

    // Readline rejects on Ctrl+C itself; no process signal reaches the command.
    const prompt: CliInteraction['prompt'] = () =>
      Promise.reject(new DOMException('Aborted with Ctrl+C', 'AbortError'));

    const exitCode = await runCli(['metric', 'test'], {
      interaction: { ci: false, inputIsTTY: true, outputIsTTY: true, prompt },
      io: { error: (line) => errors.push(line), output: () => {} },
    });

    expect(exitCode).toBe(130);
    expect(errors).toEqual([expect.stringContaining('cancelled: Command cancelled.')]);
  });
});
