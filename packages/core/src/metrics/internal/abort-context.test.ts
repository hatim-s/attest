import { describe, expect, it, vi } from 'vitest';

import { createAbortContext } from './abort-context.js';

describe('createAbortContext', () => {
  it('releases its timeout after a successful resource lifecycle', () => {
    vi.useFakeTimers();
    const context = createAbortContext({ timeoutMs: 50, timeoutMessage: 'timed out' });

    context.dispose();
    vi.advanceTimersByTime(50);

    expect(context.controller.signal.aborted).toBe(false);
    vi.useRealTimers();
  });

  it('forwards caller cancellation and removes its listener on disposal', () => {
    const controller = new AbortController();
    const context = createAbortContext({ signal: controller.signal, timeoutMessage: 'timed out' });

    controller.abort('cancelled');
    context.dispose();

    expect(context.reason()).toBe('cancelled');
    expect(context.controller.signal.reason).toBe('cancelled');
  });
});
