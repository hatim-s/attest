type CompletedResult<R> = { index: number; result: R };

type SettledResult<R> =
  | { status: 'fulfilled'; index: number; value: CompletedResult<R> }
  | { status: 'rejected'; index: number; reason: unknown };

const COMPLETION_BUFFER_FACTOR = 2;

const requireValidLimit = (limit: number): void => {
  if (Number.isInteger(limit) && limit > 0) {
    return;
  }

  throw new TypeError('Concurrency limit must be a positive integer');
};

const runMapper = async <T, R>(
  item: T,
  index: number,
  signal: AbortSignal,
  mapper: (item: T, index: number, signal: AbortSignal) => Promise<R>,
): Promise<SettledResult<R>> => {
  try {
    return {
      status: 'fulfilled',
      index,
      value: { index, result: await mapper(item, index, signal) },
    };
  } catch (reason) {
    return { status: 'rejected', index, reason };
  }
};

const composePoolSignal = (
  poolController: AbortController,
  callerSignal: AbortSignal | undefined,
): AbortSignal => {
  return callerSignal === undefined
    ? poolController.signal
    : AbortSignal.any([poolController.signal, callerSignal]);
};

/**
 * Maps work with bounded concurrency and completion-order delivery per
 * docs/specs/agent-contract.md. Iterator closure aborts and drains all owned work so callers never
 * regain control while an invocation remains active; consumer-paced refills bound buffered results.
 */
async function* mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  options: { signal?: AbortSignal } = {},
): AsyncIterable<CompletedResult<R>> {
  requireValidLimit(limit);
  const poolController = new AbortController();
  const signal = composePoolSignal(poolController, options.signal);
  const maximumBufferedCompletions = COMPLETION_BUFFER_FACTOR * limit;
  const completed: SettledResult<R>[] = [];
  const pending = new Map<number, Promise<void>>();
  let nextIndex = 0;
  let mapperFailure: unknown;
  let notifyCompletion: (() => void) | undefined;

  const scheduleAvailable = (): void => {
    while (
      pending.size < limit &&
      completed.length + pending.size < maximumBufferedCompletions &&
      nextIndex < items.length &&
      !signal.aborted &&
      mapperFailure === undefined
    ) {
      const index = nextIndex;
      const item = items[index] as T;
      nextIndex += 1;
      const task = runMapper(item, index, signal, mapper).then((settled) => {
        pending.delete(index);
        completed.push(settled);
        if (settled.status === 'rejected') {
          mapperFailure = settled.reason;
          poolController.abort(settled.reason);
        }
        notifyCompletion?.();
        notifyCompletion = undefined;
      });
      pending.set(index, task);
    }
  };

  try {
    scheduleAvailable();
    while (pending.size > 0 || completed.length > 0) {
      if (completed.length === 0) {
        await new Promise<void>((resolve) => {
          notifyCompletion = resolve;
        });
      }

      const settled = completed.shift();
      if (settled === undefined) {
        throw new TypeError('Concurrency pool completion notification had no result');
      }
      if (settled.status === 'rejected') {
        throw settled.reason;
      }

      yield settled.value;
      // A yielded value has now been consumed, so one bounded buffer slot can be refilled.
      scheduleAvailable();
    }
  } finally {
    poolController.abort();
    await Promise.all(pending.values());
  }
}

export { mapBounded };
