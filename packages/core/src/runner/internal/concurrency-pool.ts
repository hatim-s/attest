type CompletedResult<R> = { index: number; result: R };

type SettledResult<R> =
  | { status: 'fulfilled'; index: number; value: CompletedResult<R> }
  | { status: 'rejected'; index: number; reason: unknown };

const requireValidLimit = (limit: number): void => {
  if (Number.isInteger(limit) && limit > 0) {
    return;
  }

  throw new TypeError('Concurrency limit must be a positive integer');
};

const runMapper = async <T, R>(
  item: T,
  index: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<SettledResult<R>> => {
  try {
    return { status: 'fulfilled', index, value: { index, result: await mapper(item, index) } };
  } catch (reason) {
    return { status: 'rejected', index, reason };
  }
};

/**
 * Maps work with a fixed concurrency bound and yields in completion order, as required by the
 * concurrency semantics in docs/specs/agent-contract.md. Aborting prevents new scheduling while
 * allowing already-started mappers to observe the caller-owned signal through their closure.
 */
async function* mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
  options: { signal?: AbortSignal } = {},
): AsyncIterable<CompletedResult<R>> {
  requireValidLimit(limit);
  const completed: SettledResult<R>[] = [];
  const pending = new Map<number, Promise<void>>();
  let nextIndex = 0;
  let mapperFailure: unknown;
  let notifyCompletion: (() => void) | undefined;

  const scheduleAvailable = (): void => {
    while (
      pending.size < limit &&
      nextIndex < items.length &&
      options.signal?.aborted !== true &&
      mapperFailure === undefined
    ) {
      const index = nextIndex;
      // The loop bound proves this lookup exists even when T itself includes undefined.
      const item = items[index] as T;
      nextIndex += 1;
      const task = runMapper(item, index, mapper).then((settled) => {
        pending.delete(index);
        completed.push(settled);
        if (settled.status === 'rejected') {
          mapperFailure = settled.reason;
        }
        notifyCompletion?.();
        notifyCompletion = undefined;
        // The caller must never observe work starting after the iterator has thrown.
        if (mapperFailure === undefined) {
          // Refill immediately so a slow stream consumer does not idle the worker pool.
          scheduleAvailable();
        }
      });
      pending.set(index, task);
    }
  };

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
      await Promise.all(pending.values());
      throw settled.reason;
    }

    yield settled.value;
  }
}

export { mapBounded };
