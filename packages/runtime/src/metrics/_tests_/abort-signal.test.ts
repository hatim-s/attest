import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { abortReasonOf, composeAbortSignal } from '../internal/abort-signal.js';

const execute = promisify(execFile);

/** Force collection in a fresh process without changing the test runner's global runtime. */
describe('metric deadline ownership', () => {
  it.each(['timeout-only', 'with-caller'])(
    'retains the %s deadline through garbage collection',
    async (mode) => {
      const fixture = fileURLToPath(
        new URL('./fixtures/abort-signal/gc-deadline.mjs', import.meta.url),
      );

      const { stdout } = await execute(process.execPath, [
        '--expose-gc',
        '--experimental-strip-types',
        fixture,
        mode,
      ]);

      expect(stdout).toBe('TimeoutError');
    },
  );

  it('passes through one caller signal and preserves cancellation reasons', () => {
    const caller = new AbortController();
    expect(composeAbortSignal(caller.signal)).toBe(caller.signal);
    const combined = composeAbortSignal(caller.signal, 1_000);
    const reason = new Error('caller cancelled');
    caller.abort(reason);
    expect(combined.reason).toBe(reason);
    expect(abortReasonOf(combined)).toBe('cancelled');
  });
});
