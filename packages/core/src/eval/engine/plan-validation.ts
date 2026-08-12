import { CLI_EVENT_SCHEMA_ID, type EvalEvent, type EvalRunSummary } from '@attest/contracts';

import type {
  EvalEventLimits,
  EvalTerminalFailureFactory,
  ImmutableEvalRun,
  ResolvedEvalPlan,
} from '../types.js';
import { completedResult } from './run-model.js';

const DEFAULT_EVENT_LIMITS: EvalEventLimits = {
  max_events: 100_003,
  max_event_bytes: 16 * 1024,
};
const MINIMUM_EVENT_BYTES = 1024;

/** Verifies that opaque cases still match the frozen snapshot and configured order exactly. */
const validateResolvedPlan = (
  plan: ResolvedEvalPlan,
  run: ImmutableEvalRun,
): string | undefined => {
  const selectedCases = run.snapshot.selected_cases;
  if (selectedCases.length !== plan.cases.length) {
    return 'Resolved case count does not match the immutable eval snapshot.';
  }
  for (let index = 0; index < plan.cases.length; index += 1) {
    const resolvedCase = plan.cases[index];
    const selectedCase = selectedCases[index];
    if (
      resolvedCase === undefined ||
      selectedCase === undefined ||
      resolvedCase.configured_index !== index ||
      selectedCase.configured_index !== index ||
      resolvedCase.test_id !== selectedCase.test_id ||
      resolvedCase.case_id !== selectedCase.case_id ||
      JSON.stringify(resolvedCase.source) !== JSON.stringify(selectedCase.source)
    ) {
      return `Resolved case at configured index ${String(index)} drifted from the immutable eval snapshot.`;
    }
    if (
      resolvedCase.test_concurrency !== undefined &&
      (!Number.isInteger(resolvedCase.test_concurrency) || resolvedCase.test_concurrency < 1)
    ) {
      return `Resolved test concurrency at configured index ${String(index)} must be a positive integer.`;
    }
  }
  return undefined;
};

/** Preflights the largest case events so byte caps fail before a run or adapter is touched. */
const eventBytesFit = (
  plan: ResolvedEvalPlan,
  run: ImmutableEvalRun,
  limits: EvalEventLimits,
  terminalFailure: EvalTerminalFailureFactory,
): boolean => {
  const envelopeBytes = (event: Omit<EvalEvent, 'schema' | 'sequence' | 'time'>): number =>
    Buffer.byteLength(
      JSON.stringify({
        schema: CLI_EVENT_SCHEMA_ID,
        sequence: plan.cases.length * 2 + 2,
        time: run.created_at,
        ...event,
      }),
      'utf8',
    );

  const maximumSummary: EvalRunSummary = {
    total_cases: plan.cases.length,
    passed_cases: 0,
    failed_cases: plan.cases.length,
    error_cases: 0,
    metric_error_count: plan.cases.length,
  };
  const fixedEventsFit = [
    {
      event: 'run_started' as const,
      data: {
        run_id: run.run_id,
        snapshot_hash: run.snapshot_hash,
        total_cases: plan.cases.length,
        concurrency: run.effective_command.resolved.concurrency,
        timeout_ms: run.effective_command.resolved.timeout_ms,
      },
    },
    {
      event: 'run_completed' as const,
      data: { run_id: run.run_id, status: 'completed' as const, summary: maximumSummary },
    },
    { event: 'result' as const, data: completedResult(run, maximumSummary) },
    {
      event: 'result' as const,
      data: terminalFailure('run_failed', 'Eval run encountered an error.'),
    },
  ].every((event) => envelopeBytes(event) <= limits.max_event_bytes);

  return (
    fixedEventsFit &&
    plan.cases.every((resolvedCase) => {
      const shared = {
        run_id: run.run_id,
        test_id: resolvedCase.test_id,
        case_id: resolvedCase.case_id,
        configured_index: resolvedCase.configured_index,
      };
      return (
        envelopeBytes({ event: 'case_started', data: shared }) <= limits.max_event_bytes &&
        envelopeBytes({
          event: 'case_completed',
          data: {
            ...shared,
            completion_index: plan.cases.length,
            outcome: 'invocation_error',
            verdict: 'error',
          },
        }) <= limits.max_event_bytes
      );
    })
  );
};

/** Resolves and validates finite event limits before persistence or runner activity. */
const resolveEventLimits = (options: {
  event_limits?: Partial<EvalEventLimits>;
}): EvalEventLimits => {
  const limits = { ...DEFAULT_EVENT_LIMITS, ...options.event_limits };
  if (!Number.isInteger(limits.max_events) || limits.max_events < 1) {
    throw new TypeError('Eval max_events must be a positive integer.');
  }
  if (!Number.isInteger(limits.max_event_bytes) || limits.max_event_bytes < MINIMUM_EVENT_BYTES) {
    throw new TypeError(
      `Eval max_event_bytes must be an integer of at least ${MINIMUM_EVENT_BYTES}.`,
    );
  }
  return limits;
};

export { eventBytesFit, resolveEventLimits, validateResolvedPlan };
