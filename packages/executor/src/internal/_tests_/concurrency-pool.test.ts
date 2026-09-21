import { describe, expect, it } from 'vitest';

import { mapBounded } from '../concurrency-pool.js';

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

/** Creates a manually released promise so pool scheduling tests never depend on elapsed time. */
const createDeferred = <T>(): Deferred<T> => {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (resolve === undefined) {
    throw new TypeError('Deferred promise did not provide a resolver');
  }
  return { promise, resolve };
};

describe('mapBounded', () => {
  it('never exceeds the requested in-flight limit', async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    const releases = [createDeferred<void>(), createDeferred<void>(), createDeferred<void>()];
    const started = createDeferred<void>();
    const startLog: number[] = [];
    const resultsPromise = collect(
      mapBounded([1, 2, 3, 4, 5], 2, async (value) => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        startLog.push(value);
        if (startLog.length === 2) {
          started.resolve();
        }
        await releases[Math.floor((value - 1) / 2)]?.promise;
        inFlight -= 1;
        return value * 2;
      }),
    );

    await started.promise;
    expect(maximumInFlight).toBe(2);
    releases.forEach(({ resolve }) => resolve());
    const results = await resultsPromise;
    expect(results).toHaveLength(5);
  });

  it('yields results in completion order while retaining source indices', async () => {
    const releases = new Map([30, 5, 15].map((value) => [value, createDeferred<void>()]));
    const started = createDeferred<void>();
    let startCount = 0;
    const resultsPromise = collect(
      mapBounded([30, 5, 15], 3, async (value) => {
        startCount += 1;
        if (startCount === 3) {
          started.resolve();
        }
        await releases.get(value)?.promise;
        return value;
      }),
    );

    await started.promise;
    releases.get(5)?.resolve();
    releases.get(15)?.resolve();
    releases.get(30)?.resolve();
    const results = await resultsPromise;

    expect(results).toEqual([
      { index: 1, result: 5 },
      { index: 2, result: 15 },
      { index: 0, result: 30 },
    ]);
  });

  it('stops scheduling new items after abort while draining in-flight work', async () => {
    const controller = new AbortController();
    const scheduled: number[] = [];
    const firstCompletion = createDeferred<void>();
    const secondCompletion = createDeferred<void>();
    const started = createDeferred<void>();
    const resultsPromise = collect(
      mapBounded(
        [0, 1, 2, 3],
        2,
        async (value) => {
          scheduled.push(value);
          if (value === 0) {
            started.resolve();
            await firstCompletion.promise;
            controller.abort();
          } else {
            await secondCompletion.promise;
          }
          return value;
        },
        { signal: controller.signal },
      ),
    );

    await started.promise;
    firstCompletion.resolve();
    await Promise.resolve();
    expect(scheduled).toEqual([0, 1]);
    secondCompletion.resolve();
    const results = await resultsPromise;
    expect(results.map(({ result }) => result)).toEqual([0, 1]);
  });

  it('drains in-flight work before rejecting and never schedules after mapper failure', async () => {
    const originalError = new Error('item 2 failed');
    const firstMapperCompletion = createDeferred<void>();
    const secondMapperStarted = createDeferred<void>();
    const startLog: number[] = [];
    const iterator = mapBounded([1, 2, 3, 4, 5, 6], 2, async (value) => {
      startLog.push(value);
      if (value === 1) {
        await firstMapperCompletion.promise;
        return value;
      }
      if (value === 2) {
        secondMapperStarted.resolve();
        throw originalError;
      }
      return value;
    })[Symbol.asyncIterator]();

    let rejected = false;
    const nextResult = iterator.next().catch((error: unknown) => {
      rejected = true;
      throw error;
    });

    await secondMapperStarted.promise;
    await Promise.resolve();
    expect(rejected).toBe(false);
    expect(startLog).toEqual([1, 2]);
    firstMapperCompletion.resolve();
    await expect(nextResult).rejects.toBe(originalError);
    expect(startLog).toEqual([1, 2]);
  });

  it('waits for in-flight mappers when the consumer returns early', async () => {
    const firstCompletion = createDeferred<void>();
    const secondCompletion = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    let secondSettled = false;
    const iterator = mapBounded([1, 2], 2, async (value, _index, signal) => {
      if (value === 1) {
        await firstCompletion.promise;
        return value;
      }

      secondStarted.resolve();
      await secondCompletion.promise;
      secondSettled = true;
      expect(signal.aborted).toBe(true);
      return value;
    })[Symbol.asyncIterator]();

    const firstResult = iterator.next();
    await secondStarted.promise;
    firstCompletion.resolve();
    await expect(firstResult).resolves.toMatchObject({ done: false });
    const returnPromise = iterator.return?.();
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    secondCompletion.resolve();
    await expect(returnPromise).resolves.toMatchObject({ done: true });
    expect(secondSettled).toBe(true);
  });

  it('never buffers more than twice the limit for a slow consumer', async () => {
    const limit = 2;
    let completedCount = 0;
    let consumedCount = 0;
    let maximumUnconsumed = 0;
    const iterable = mapBounded(
      Array.from({ length: 20 }, (_, index) => index),
      limit,
      async (value) => {
        await Promise.resolve();
        completedCount += 1;
        maximumUnconsumed = Math.max(maximumUnconsumed, completedCount - consumedCount);
        return value;
      },
    );

    for await (const entry of iterable) {
      expect(entry.result).toBe(consumedCount);
      await Promise.resolve();
      consumedCount += 1;
    }

    expect(maximumUnconsumed).toBeLessThanOrEqual(2 * limit);
    expect(consumedCount).toBe(20);
  });
});
