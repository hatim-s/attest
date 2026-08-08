import { z } from 'zod';

import { cliFailureResultSchema, cliSuccessResultSchema } from './cli-protocol.js';
import { evalRunIdSchema } from './eval-run-v1.js';
import { resourceIdSchema, sha256Schema } from './v2-shared.js';
import { CLI_EVENT_SCHEMA_VERSION } from './versions.js';

const evalRunSummarySchema = z.strictObject({
  total_cases: z.number().int().nonnegative(),
  passed_cases: z.number().int().nonnegative(),
  failed_cases: z.number().int().nonnegative(),
  error_cases: z.number().int().nonnegative(),
  metric_error_count: z.number().int().nonnegative(),
});

const evalEventBaseFields = {
  schema: z.literal(CLI_EVENT_SCHEMA_VERSION),
  sequence: z.number().int().nonnegative(),
  time: z.iso.datetime({ offset: true }),
};

const evalRunStartedEventSchema = z.strictObject({
  ...evalEventBaseFields,
  event: z.literal('run_started'),
  data: z.strictObject({
    run_id: evalRunIdSchema,
    snapshot_hash: sha256Schema,
    total_cases: z.number().int().nonnegative(),
    concurrency: z.number().int().positive(),
    timeout_ms: z.number().int().positive(),
  }),
});

const evalCaseStartedEventSchema = z.strictObject({
  ...evalEventBaseFields,
  event: z.literal('case_started'),
  data: z.strictObject({
    run_id: evalRunIdSchema,
    test_id: resourceIdSchema,
    case_id: resourceIdSchema,
    configured_index: z.number().int().nonnegative(),
  }),
});

const evalCaseCompletedEventSchema = z.strictObject({
  ...evalEventBaseFields,
  event: z.literal('case_completed'),
  data: z.strictObject({
    run_id: evalRunIdSchema,
    test_id: resourceIdSchema,
    case_id: resourceIdSchema,
    configured_index: z.number().int().nonnegative(),
    completion_index: z.number().int().nonnegative(),
    outcome: z.enum(['completed', 'invocation_error', 'timeout', 'cancelled']),
    verdict: z.enum(['pass', 'fail', 'error']),
  }),
});

const evalRunCompletedEventSchema = z.strictObject({
  ...evalEventBaseFields,
  event: z.literal('run_completed'),
  data: z.strictObject({
    run_id: evalRunIdSchema,
    status: z.enum(['completed', 'failed', 'cancelled']),
    summary: evalRunSummarySchema,
  }),
});

const evalRunResultPayloadFields = {
  run_id: evalRunIdSchema,
  snapshot_hash: sha256Schema,
  status: z.literal('completed'),
  summary: evalRunSummarySchema,
  baseline_run_id: evalRunIdSchema.optional(),
  junit_path: z.string().min(1).optional(),
};

const passingEvalRunResultSchema = cliSuccessResultSchema.extend({
  command: z.literal('eval.run'),
  result: z.strictObject({ ...evalRunResultPayloadFields, verdict: z.literal('pass') }),
});

const failingEvalRunResultSchema = cliSuccessResultSchema.extend({
  command: z.literal('eval.run'),
  result: z.strictObject({ ...evalRunResultPayloadFields, verdict: z.literal('fail') }),
});

const failedEvalRunResultSchema = cliFailureResultSchema.extend({
  command: z.literal('eval.run'),
});

/** Binds every stable process exit to the compatible shared result-envelope variant. */
const evalFinalResultDataSchema = z.union([
  z.strictObject({ exit_code: z.literal(0), result: passingEvalRunResultSchema }),
  z.strictObject({ exit_code: z.literal(1), result: failingEvalRunResultSchema }),
  // Exit 1 also covers user-data validation that fails before an eval run is created.
  z.strictObject({ exit_code: z.literal(1), result: failedEvalRunResultSchema }),
  z.strictObject({ exit_code: z.literal(2), result: failedEvalRunResultSchema }),
  z.strictObject({ exit_code: z.literal(3), result: failedEvalRunResultSchema }),
  z.strictObject({ exit_code: z.literal(4), result: failedEvalRunResultSchema }),
  z.strictObject({ exit_code: z.literal(130), result: failedEvalRunResultSchema }),
]);

const evalResultEventSchema = z.strictObject({
  ...evalEventBaseFields,
  event: z.literal('result'),
  data: evalFinalResultDataSchema,
});

/** Narrows `attest.cli-event/v1` to the append-only eval orchestration vocabulary. */
const evalEventSchema = z.discriminatedUnion('event', [
  evalRunStartedEventSchema,
  evalCaseStartedEventSchema,
  evalCaseCompletedEventSchema,
  evalRunCompletedEventSchema,
  evalResultEventSchema,
]);

type EvalEvent = z.infer<typeof evalEventSchema>;
type EvalRunCompletedEvent = z.infer<typeof evalRunCompletedEventSchema>;

const caseKey = (testId: string, caseId: string): string => `${testId}\u0000${caseId}`;

/**
 * Validates the sequencing rules that one-line JSON Schema cannot express.
 * Case completion remains in observed order while configured indexes retain deterministic identity.
 */
const evalEventStreamSchema = z
  .array(evalEventSchema)
  .min(1)
  .superRefine((events, context) => {
    events.forEach((event, index) => {
      if (event.sequence !== index) {
        context.addIssue({
          code: 'custom',
          path: [index, 'sequence'],
          message: `must equal zero-based stream position ${index}`,
        });
      }
    });

    const resultIndexes = events.flatMap((event, index) =>
      event.event === 'result' ? [index] : [],
    );
    if (resultIndexes.length !== 1 || resultIndexes[0] !== events.length - 1) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'the stream must contain exactly one final result event',
      });
    }

    if (events[0]?.event === 'result') {
      const resultOnlyIsInvalid =
        events.length !== 1 ||
        events[0].data.exit_code === 0 ||
        (events[0].data.exit_code === 1 && events[0].data.result.ok);
      if (resultOnlyIsInvalid) {
        context.addIssue({
          code: 'custom',
          path: [0],
          message: 'a result-only stream must describe a pre-orchestration failure',
        });
      }
      return;
    }

    const started = events[0];
    if (started?.event !== 'run_started') {
      context.addIssue({ code: 'custom', path: [0, 'event'], message: 'must be run_started' });
      return;
    }

    const runId = started.data.run_id;
    const startedCases = new Map<string, number>();
    let lastConfiguredIndex = -1;
    let startedCaseCount = 0;
    let completionIndex = 0;
    let completedEvent: EvalRunCompletedEvent | undefined;

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
        if (event.data.configured_index <= lastConfiguredIndex || startedCases.has(key)) {
          context.addIssue({
            code: 'custom',
            path: [index, 'data', 'configured_index'],
            message: 'case starts must be unique and follow configured index order',
          });
        }
        lastConfiguredIndex = event.data.configured_index;
        startedCases.set(key, event.data.configured_index);
        startedCaseCount += 1;
      }

      if (event.event === 'case_completed') {
        const key = caseKey(event.data.test_id, event.data.case_id);
        if (
          startedCases.get(key) !== event.data.configured_index ||
          event.data.completion_index !== completionIndex
        ) {
          context.addIssue({
            code: 'custom',
            path: [index, 'data'],
            message: 'completion must reference its start and retain observed completion order',
          });
        }
        startedCases.delete(key);
        completionIndex += 1;
      }

      if (event.event === 'run_completed') {
        if (completedEvent !== undefined || index !== events.length - 2) {
          context.addIssue({
            code: 'custom',
            path: [index, 'event'],
            message: 'run_completed must occur exactly once immediately before result',
          });
        }
        completedEvent = event;
      }
    });

    if (completedEvent === undefined) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'orchestration must emit run_completed',
      });
      return;
    }

    const summary = completedEvent.data.summary;
    const summaryCountsMatch =
      summary.total_cases === started.data.total_cases &&
      summary.passed_cases + summary.failed_cases + summary.error_cases === summary.total_cases;
    const caseLifecycleMatches =
      completedEvent.data.status === 'failed'
        ? startedCaseCount <= started.data.total_cases && completionIndex === startedCaseCount
        : startedCaseCount === started.data.total_cases &&
          completionIndex === started.data.total_cases;
    if (startedCases.size !== 0 || !summaryCountsMatch || !caseLifecycleMatches) {
      context.addIssue({
        code: 'custom',
        path: [events.length - 2, 'data', 'summary'],
        message: 'run totals must match the started, completed, and summarized cases',
      });
    }

    const finalEvent = events.at(-1);
    if (finalEvent?.event !== 'result') return;
    const allowedExitCodes =
      completedEvent.data.status === 'completed'
        ? [0, 1]
        : completedEvent.data.status === 'failed'
          ? [4]
          : [130];
    if (!allowedExitCodes.includes(finalEvent.data.exit_code)) {
      context.addIssue({
        code: 'custom',
        path: [events.length - 1, 'data', 'exit_code'],
        message: `does not match terminal status ${completedEvent.data.status}`,
      });
    }
    if (completedEvent.data.status === 'completed') {
      const result = finalEvent.data.result;
      if (
        !result.ok ||
        result.result.run_id !== runId ||
        result.result.snapshot_hash !== started.data.snapshot_hash ||
        JSON.stringify(result.result.summary) !== JSON.stringify(summary)
      ) {
        context.addIssue({
          code: 'custom',
          path: [events.length - 1, 'data', 'result'],
          message: 'completed result metadata must match the orchestration stream',
        });
      }
    }
  });

type EvalEventStream = z.infer<typeof evalEventStreamSchema>;
type EvalFinalResultData = z.infer<typeof evalFinalResultDataSchema>;
type EvalRunSummary = z.infer<typeof evalRunSummarySchema>;

export {
  evalCaseCompletedEventSchema,
  evalCaseStartedEventSchema,
  evalEventSchema,
  evalEventStreamSchema,
  evalFinalResultDataSchema,
  evalResultEventSchema,
  evalRunCompletedEventSchema,
  evalRunStartedEventSchema,
  evalRunSummarySchema,
  type EvalEvent,
  type EvalEventStream,
  type EvalFinalResultData,
  type EvalRunSummary,
};
