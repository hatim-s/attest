type EnvironmentLifecycleOptions = {
  /** The case run signal; run-phase operations stop when it aborts. */
  signal: AbortSignal;
  /** Separate deadline for work admitted after `beginFinalization`. */
  finalizationTimeoutMs: number;
  /** Error reported once the environment is poisoned; only environments that can poison set it. */
  poisonedError?: () => Error;
};

type EnvironmentLifecycle = {
  /** Admits an operation in the current phase and tracks it until it settles. */
  track: <Value>(operation: (admitted: AbortSignal) => Promise<Value>) => Promise<Value>;
  /** Cancels and drains run work, then opens the finalization deadline. */
  beginFinalization: () => Promise<void>;
  /** Refuses all later work and aborts admitted work because the backing state is unknown. */
  poison: (reason: unknown) => void;
  /** Refuses all later work, aborts both phases, and resolves once admitted work settles. */
  close: (reason: Error) => Promise<void>;
};

type Phase =
  | { kind: 'run' }
  | { kind: 'transitioning' }
  | { kind: 'finalizing'; signal: AbortSignal }
  | { kind: 'poisoned' }
  | { kind: 'disposed' };

const disposedError = (): Error => new Error('Case environment has been disposed.');

/**
 * Tracks the phases every case environment shares: run work, a drained transition, bounded
 * final-hook work, and disposal. Environments that talk to a VM can also be poisoned.
 */
const createEnvironmentLifecycle = (options: EnvironmentLifecycleOptions): EnvironmentLifecycle => {
  const runLifetime = new AbortController();
  const finalizationLifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const poisonedError =
    options.poisonedError ?? ((): Error => new Error('Case environment has been poisoned.'));
  let phase: Phase = { kind: 'run' };
  let transition: Promise<void> | undefined;
  // Read through a call so control-flow narrowing cannot survive the awaits below.
  const currentPhase = (): Phase => phase;

  const admissionSignal = (): AbortSignal => {
    const current = currentPhase();
    if (current.kind === 'disposed') throw disposedError();
    if (current.kind === 'poisoned') throw poisonedError();
    if (current.kind === 'transitioning') {
      throw new Error('Case environment finalization is starting.');
    }
    const admitted =
      current.kind === 'run'
        ? AbortSignal.any([options.signal, runLifetime.signal])
        : current.signal;
    admitted.throwIfAborted();
    return admitted;
  };

  const track = <Value>(operation: (admitted: AbortSignal) => Promise<Value>): Promise<Value> => {
    const admitted = admissionSignal();
    const task = Promise.resolve().then(() => {
      admitted.throwIfAborted();
      return operation(admitted);
    });
    pending.add(task);
    const forget = (): void => {
      pending.delete(task);
    };
    void task.then(forget, forget);
    return task;
  };

  const beginFinalization = (): Promise<void> => {
    const current = currentPhase();
    if (current.kind === 'disposed') return Promise.reject(disposedError());
    if (current.kind === 'poisoned') return Promise.reject(poisonedError());
    transition ??= (async () => {
      phase = { kind: 'transitioning' };
      runLifetime.abort(new Error('Case run operations cancelled for finalization.'));
      await Promise.allSettled([...pending]);
      const drained = currentPhase();
      if (drained.kind === 'poisoned') throw poisonedError();
      if (drained.kind === 'disposed') throw disposedError();
      phase = {
        kind: 'finalizing',
        signal: AbortSignal.any([
          finalizationLifetime.signal,
          AbortSignal.timeout(options.finalizationTimeoutMs),
        ]),
      };
    })();
    return transition;
  };

  return {
    track,
    beginFinalization,
    poison: (reason) => {
      if (currentPhase().kind !== 'disposed') phase = { kind: 'poisoned' };
      runLifetime.abort(reason);
      finalizationLifetime.abort(reason);
    },
    close: async (reason) => {
      phase = { kind: 'disposed' };
      runLifetime.abort(reason);
      finalizationLifetime.abort(reason);
      await Promise.allSettled([...pending]);
    },
  };
};

export { createEnvironmentLifecycle, type EnvironmentLifecycle };
