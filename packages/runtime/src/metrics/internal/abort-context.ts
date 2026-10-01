/** Owns a composed cancellation deadline so completed metric HTTP calls do not retain timeout signals. */
type AbortContext = {
  controller: AbortController;
  dispose: () => void;
  reason: () => 'cancelled' | 'timeout' | undefined;
};

/** Supplies external cancellation and an optional deadline to the resource boundary that owns cleanup. */
type CreateAbortContextOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutMessage: string;
};

/**
 * Composes caller cancellation with an owned timeout so edge resources can release listeners and timers in
 * `finally`, as required by the metric transport lifecycle.
 */
const createAbortContext = (options: CreateAbortContextOptions): AbortContext => {
  const controller = new AbortController();
  let abortReason: 'cancelled' | 'timeout' | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    if (abortReason !== undefined) {
      return;
    }
    abortReason = 'cancelled';
    controller.abort(options.signal?.reason);
  };

  if (options.signal?.aborted) {
    cancel();
  } else {
    options.signal?.addEventListener('abort', cancel, { once: true });
  }
  if (options.timeoutMs !== undefined && abortReason === undefined) {
    timeout = setTimeout(() => {
      if (abortReason !== undefined) {
        return;
      }
      abortReason = 'timeout';
      controller.abort(new Error(options.timeoutMessage));
    }, options.timeoutMs);
  }

  return {
    controller,
    reason: () => abortReason,
    dispose: () => {
      options.signal?.removeEventListener('abort', cancel);
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    },
  };
};

export { createAbortContext, type AbortContext, type CreateAbortContextOptions };
