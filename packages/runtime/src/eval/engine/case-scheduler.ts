import type { ResolvedEvalCase } from '../types.js';

/** Cases of one test, admitted in configured order up to that test's concurrency cap. */
type TestQueue<Payload> = {
  cases: ResolvedEvalCase<Payload>[];
  next: number;
  active: number;
  limit: number;
};

/** Hands cases to worker slots and learns when a slot's case settles. */
type CaseScheduler<Payload> = {
  take(workerIndex: number): ResolvedEvalCase<Payload> | undefined;
  release(resolvedCase: ResolvedEvalCase<Payload>): void;
};

/** Divides configured cases into balanced contiguous batches, assigning extra cases from the front. */
const createWorkerBatches = <Payload>(
  cases: readonly ResolvedEvalCase<Payload>[],
  requestedWorkers: number,
): ResolvedEvalCase<Payload>[][] => {
  const workerCount = Math.min(requestedWorkers, cases.length);
  if (workerCount === 0) return [];
  const minimumBatchSize = Math.floor(cases.length / workerCount);
  const workersWithExtraCase = cases.length % workerCount;
  let offset = 0;
  return Array.from({ length: workerCount }, (_, workerIndex) => {
    const size = minimumBatchSize + (workerIndex < workersWithExtraCase ? 1 : 0);
    const batch = cases.slice(offset, offset + size);
    offset += size;
    return batch;
  });
};

/** Groups cases by test, capping each test at the tighter of its own and the global limit. */
const createTestQueues = <Payload>(
  cases: readonly ResolvedEvalCase<Payload>[],
  concurrency: number,
): Map<string, TestQueue<Payload>> => {
  const queues = new Map<string, TestQueue<Payload>>();
  for (const resolvedCase of cases) {
    const limit = resolvedCase.test_concurrency ?? concurrency;
    const queue = queues.get(resolvedCase.test_id);
    if (queue === undefined) {
      queues.set(resolvedCase.test_id, { cases: [resolvedCase], next: 0, active: 0, limit });
      continue;
    }
    queue.limit = Math.min(queue.limit, limit);
    queue.cases.push(resolvedCase);
  }
  return queues;
};

/**
 * Fixed worker batches keep each case on its worker's directory. Without workers, the scheduler
 * admits the earliest configured case among tests still under their cap.
 */
const createCaseScheduler = <Payload>(
  cases: readonly ResolvedEvalCase<Payload>[],
  options: { concurrency: number; workerCount?: number },
): CaseScheduler<Payload> => {
  if (options.workerCount !== undefined) {
    const batches = createWorkerBatches(cases, options.workerCount);
    const nextByWorker = batches.map(() => 0);
    return {
      take: (workerIndex) => {
        const next = nextByWorker[workerIndex] ?? 0;
        nextByWorker[workerIndex] = next + 1;
        return batches[workerIndex]?.[next];
      },
      release: () => undefined,
    };
  }

  const queues = createTestQueues(cases, options.concurrency);
  const nextConfiguredIndex = (queue: TestQueue<Payload>): number =>
    queue.cases[queue.next]?.configured_index ?? Number.POSITIVE_INFINITY;
  return {
    take: () => {
      const [queue] = [...queues.values()]
        .filter(({ active, limit, next, cases }) => active < limit && next < cases.length)
        .sort((left, right) => nextConfiguredIndex(left) - nextConfiguredIndex(right));
      if (queue === undefined) return undefined;
      const selected = queue.cases[queue.next];
      queue.next += 1;
      queue.active += 1;
      return selected;
    },
    release: (resolvedCase) => {
      const queue = queues.get(resolvedCase.test_id);
      if (queue !== undefined) queue.active -= 1;
    },
  };
};

export { createCaseScheduler };
