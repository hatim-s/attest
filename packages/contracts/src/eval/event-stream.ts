import { z } from 'zod';

import { evalEventSchema, type EvalEvent } from './event.js';

type RunStartedEvent = Extract<EvalEvent, { event: 'run_started' }>;
type RunCompletedEvent = Extract<EvalEvent, { event: 'run_completed' }>;
type RunStatus = RunCompletedEvent['data']['status'];

/** Case lifecycle counts observed between run_started and the final result. */
type CaseLifecycle = {
  /** Cases started but not yet completed, keyed by caseKey. */
  openCases: Map<string, number>;
  startedCount: number;
  completedCount: number;
  completedEvent: RunCompletedEvent | undefined;
};

const allowedExitCodes: Record<RunStatus, readonly number[]> = {
  completed: [0, 1],
  failed: [4],
  cancelled: [130],
};

// Test and case ids are slugs, so ':' cannot appear inside either part.
const caseKey = (testId: string, caseId: string): string => `${testId}:${caseId}`;

const reportSequenceNumbers = (events: readonly EvalEvent[], context: z.RefinementCtx): void => {
  events.forEach((event, index) => {
    if (event.sequence === index) {
      return;
    }
    context.addIssue({
      code: 'custom',
      path: [index, 'sequence'],
      message: `must equal zero-based stream position ${index}`,
    });
  });
};

const reportResultPlacement = (events: readonly EvalEvent[], context: z.RefinementCtx): void => {
  const resultIndexes = events.flatMap((event, index) => (event.event === 'result' ? [index] : []));
  if (resultIndexes.length === 1 && resultIndexes[0] === events.length - 1) {
    return;
  }
  context.addIssue({
    code: 'custom',
    path: [],
    message: 'the stream must contain exactly one final result event',
  });
};

/** A stream that opens with its result must be a single pre-orchestration failure. */
const reportResultOnlyStream = (
  events: readonly EvalEvent[],
  result: Extract<EvalEvent, { event: 'result' }>,
  context: z.RefinementCtx,
): void => {
  const { exit_code, result: envelope } = result.data;
  const describesFailure = exit_code !== 0 && !(exit_code === 1 && envelope.ok);
  if (events.length === 1 && describesFailure) {
    return;
  }
  context.addIssue({
    code: 'custom',
    path: [0],
    message: 'a result-only stream must describe a pre-orchestration failure',
  });
};

const collectCaseLifecycle = (
  events: readonly EvalEvent[],
  runId: string,
  context: z.RefinementCtx,
): CaseLifecycle => {
  const lifecycle: CaseLifecycle = {
    openCases: new Map(),
    startedCount: 0,
    completedCount: 0,
    completedEvent: undefined,
  };
  const startedIndexes = new Set<number>();

  events.slice(1, -1).forEach((event, offset) => {
    const index = offset + 1;
    if (event.event === 'result') {
      return;
    }
    if (event.data.run_id !== runId) {
      context.addIssue({
        code: 'custom',
        path: [index, 'data', 'run_id'],
        message: 'run id drifted',
      });
    }

    if (event.event === 'case_started') {
      const key = caseKey(event.data.test_id, event.data.case_id);
      if (startedIndexes.has(event.data.configured_index) || lifecycle.openCases.has(key)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'data', 'configured_index'],
          message: 'case starts must have unique identities and configured indexes',
        });
      }
      startedIndexes.add(event.data.configured_index);
      lifecycle.openCases.set(key, event.data.configured_index);
      lifecycle.startedCount += 1;
      return;
    }

    if (event.event === 'case_completed') {
      const key = caseKey(event.data.test_id, event.data.case_id);
      if (
        lifecycle.openCases.get(key) !== event.data.configured_index ||
        event.data.completion_index !== lifecycle.completedCount
      ) {
        context.addIssue({
          code: 'custom',
          path: [index, 'data'],
          message: 'completion must reference its start and retain observed completion order',
        });
      }
      lifecycle.openCases.delete(key);
      lifecycle.completedCount += 1;
      return;
    }

    if (event.event === 'run_completed') {
      if (lifecycle.completedEvent !== undefined || index !== events.length - 2) {
        context.addIssue({
          code: 'custom',
          path: [index, 'event'],
          message: 'run_completed must occur exactly once immediately before result',
        });
      }
      lifecycle.completedEvent = event;
    }
  });

  return lifecycle;
};

/**
 * A failed run may stop early, so its totals follow the cases that actually ran. Every other
 * status must account for each planned case.
 */
const totalsMatch = (
  started: RunStartedEvent,
  completed: RunCompletedEvent,
  lifecycle: CaseLifecycle,
): boolean => {
  const { summary, status } = completed.data;
  const planned = started.data.total_cases;
  if (lifecycle.openCases.size !== 0) {
    return false;
  }
  if (summary.passed_cases + summary.failed_cases + summary.error_cases !== summary.total_cases) {
    return false;
  }
  if (status === 'failed') {
    return (
      summary.total_cases === lifecycle.completedCount &&
      lifecycle.startedCount <= planned &&
      lifecycle.completedCount === lifecycle.startedCount
    );
  }

  return (
    summary.total_cases === planned &&
    lifecycle.startedCount === planned &&
    lifecycle.completedCount === planned
  );
};

const reportFinalResult = (
  events: readonly EvalEvent[],
  started: RunStartedEvent,
  completed: RunCompletedEvent,
  context: z.RefinementCtx,
): void => {
  const finalEvent = events.at(-1);
  if (finalEvent?.event !== 'result') {
    return;
  }

  const { status, summary } = completed.data;
  const resultPath = [events.length - 1, 'data'];
  if (!allowedExitCodes[status].includes(finalEvent.data.exit_code)) {
    context.addIssue({
      code: 'custom',
      path: [...resultPath, 'exit_code'],
      message: `does not match terminal status ${status}`,
    });
  }
  if (status !== 'completed') {
    return;
  }

  const result = finalEvent.data.result;
  if (
    !result.ok ||
    result.result.run_id !== started.data.run_id ||
    result.result.snapshot_hash !== started.data.snapshot_hash ||
    JSON.stringify(result.result.summary) !== JSON.stringify(summary)
  ) {
    context.addIssue({
      code: 'custom',
      path: [...resultPath, 'result'],
      message: 'completed result metadata must match the orchestration stream',
    });
  }
};

/**
 * Checks the sequencing rules that per-line JSON Schema cannot express. Cases complete in
 * observed order while configured indexes keep their deterministic identity.
 */
const validateEvalEventStream = (events: readonly EvalEvent[], context: z.RefinementCtx): void => {
  reportSequenceNumbers(events, context);
  reportResultPlacement(events, context);

  const first = events[0];
  if (first?.event === 'result') {
    reportResultOnlyStream(events, first, context);
    return;
  }
  if (first?.event !== 'run_started') {
    context.addIssue({ code: 'custom', path: [0, 'event'], message: 'must be run_started' });
    return;
  }

  const lifecycle = collectCaseLifecycle(events, first.data.run_id, context);
  const completed = lifecycle.completedEvent;
  if (completed === undefined) {
    context.addIssue({
      code: 'custom',
      path: [],
      message: 'orchestration must emit run_completed',
    });
    return;
  }

  if (!totalsMatch(first, completed, lifecycle)) {
    context.addIssue({
      code: 'custom',
      path: [events.length - 2, 'data', 'summary'],
      message: 'run totals must match the started, completed, and summarized cases',
    });
  }
  reportFinalResult(events, first, completed, context);
};

/** Encodes one complete `attest eval run --output jsonl` stream. */
const evalEventStreamSchema = z.array(evalEventSchema).min(1).superRefine(validateEvalEventStream);

type EvalEventStream = z.infer<typeof evalEventStreamSchema>;

export { evalEventStreamSchema, type EvalEventStream };
