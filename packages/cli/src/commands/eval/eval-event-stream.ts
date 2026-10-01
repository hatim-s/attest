import {
  CLI_EVENT_SCHEMA_ID,
  evalEventSchema,
  evalEventStreamSchema,
  evalFinalResultDataSchema,
  type EvalEvent,
  type EvalEventStream,
} from '@attest/contracts';

import { AttestCliError, serializeCliError } from '../../errors/cli-error.js';
import { createCliFailureResult } from '../../output/cli-protocol.js';
import type { CliIo } from '../shared/command-context.js';
import { issueDiagnostics } from './eval-request.js';

type EvalEventSource = AsyncIterable<EvalEvent> | Iterable<EvalEvent>;

type Clock = () => Date;

type CollectEvalEventsOptions = {
  io: CliIo;
  now: Clock;
  /** Print each event as a JSONL line as soon as it arrives. */
  streamJsonl: boolean;
  /** Print human progress lines as events arrive. */
  watch: boolean;
};

/** Builds and validates one event line of the eval JSONL stream. */
const evalEvent = (
  sequence: number,
  event: EvalEvent['event'],
  data: unknown,
  now: Clock,
): EvalEvent =>
  evalEventSchema.parse({
    schema: CLI_EVENT_SCHEMA_ID,
    sequence,
    time: now().toISOString(),
    event,
    data,
  });

const serializeEvalEvent = (event: EvalEvent): string => JSON.stringify(event);

/** Renders one live progress event as a plain line, or nothing for the final result. */
const renderHumanProgress = (event: EvalEvent): string | undefined => {
  switch (event.event) {
    case 'run_started':
      return `Run ${event.data.run_id} started: ${event.data.total_cases} cases, concurrency ${event.data.concurrency}.`;
    case 'case_started':
      return `[${event.data.configured_index + 1}] ${event.data.test_id}/${event.data.case_id} started.`;
    case 'case_completed':
      return `[${event.data.configured_index + 1}] ${event.data.test_id}/${event.data.case_id} ${event.data.verdict}.`;
    case 'run_completed':
      return `Run ${event.data.run_id} ${event.data.status}: ${event.data.summary.passed_cases} passed, ${event.data.summary.failed_cases} failed, ${event.data.summary.error_cases} errors.`;
    case 'result':
      return undefined;
  }
};

/**
 * Finishes a JSONL stream whose source failed after it started. Lines already printed stay
 * valid: open cases complete as errors, then one failed run completion and one result follow.
 */
const recoverFailedJsonlStream = (
  events: readonly EvalEvent[],
  error: unknown,
  now: Clock,
): EvalEventStream => {
  const alreadyComplete = evalEventStreamSchema.safeParse(events);
  if (alreadyComplete.success) return alreadyComplete.data;
  const started = events[0];
  if (started?.event !== 'run_started') throw error;

  // The collector holds back terminal events, so they can be replaced after a failure.
  const recovered: EvalEvent[] = events.filter(
    (event) => event.event !== 'run_completed' && event.event !== 'result',
  );
  const openCases = new Map<string, Extract<EvalEvent, { event: 'case_started' }>['data']>();
  const summary = {
    // Counts only emitted case completions; the selection size stays on run_started.
    total_cases: 0,
    passed_cases: 0,
    failed_cases: 0,
    error_cases: 0,
    metric_error_count: 0,
  };
  for (const event of recovered) {
    if (event.event === 'case_started') {
      openCases.set(`${event.data.test_id}\u0000${event.data.case_id}`, event.data);
    } else if (event.event === 'case_completed') {
      openCases.delete(`${event.data.test_id}\u0000${event.data.case_id}`);
      summary.total_cases += 1;
      if (event.data.verdict === 'pass') summary.passed_cases += 1;
      else if (event.data.verdict === 'fail') summary.failed_cases += 1;
      else summary.error_cases += 1;
    }
  }

  for (const openCase of openCases.values()) {
    const data = {
      ...openCase,
      completion_index: summary.total_cases,
      outcome: 'invocation_error',
      verdict: 'error',
    };
    recovered.push(evalEvent(recovered.length, 'case_completed', data, now));
    summary.total_cases += 1;
    summary.error_cases += 1;
  }
  const completion = { run_id: started.data.run_id, status: 'failed', summary };
  recovered.push(evalEvent(recovered.length, 'run_completed', completion, now));
  const failure = serializeCliError(
    new AttestCliError('run_failed', 'Eval event source failed after orchestration started.', {
      cause: error,
    }),
  );
  const result = evalFinalResultDataSchema.parse({
    exit_code: failure.exitCode,
    result: createCliFailureResult('eval.run', failure.error),
  });
  recovered.push(evalEvent(recovered.length, 'result', result, now));
  return evalEventStreamSchema.parse(recovered);
};

/**
 * Reads the whole event stream, checking contiguous sequence numbers, and prints JSONL lines or
 * human progress while it runs. `run_completed` is printed only together with the result, so a
 * source failure can still replace it.
 */
const collectEvalEvents = async (
  source: EvalEventSource,
  options: CollectEvalEventsOptions,
): Promise<EvalEventStream> => {
  const events: EvalEvent[] = [];
  let printed = 0;
  const print = (event: EvalEvent): void => {
    options.io.output(serializeEvalEvent(event));
    printed += 1;
  };
  try {
    for await (const value of source) {
      const event = evalEventSchema.parse(value);
      if (event.sequence !== events.length) {
        throw new AttestCliError('run_failed', 'Eval event sequence is not deterministic.', {
          path: `/events/${events.length}/sequence`,
          hint: `Expected sequence ${events.length}; the dispatcher must emit contiguous zero-based events.`,
        });
      }
      events.push(event);
      if (options.streamJsonl && event.event !== 'run_completed' && event.event !== 'result')
        print(event);
      if (options.watch) {
        const rendered = renderHumanProgress(event);
        if (rendered !== undefined) options.io.output(rendered);
      }
    }
    const parsed = evalEventStreamSchema.safeParse(events);
    if (!parsed.success) {
      throw new AttestCliError('run_failed', 'Eval event stream is out of order or incomplete.', {
        hint: 'Repair dispatcher event ordering and terminal result metadata.',
        details: { diagnostics: issueDiagnostics(parsed.error.issues) },
      });
    }
    if (options.streamJsonl) parsed.data.slice(printed).forEach(print);
    return parsed.data;
  } catch (error: unknown) {
    if (!options.streamJsonl || events.length === 0) throw error;
    const recovered = recoverFailedJsonlStream(events, error, options.now);
    recovered.slice(printed).forEach((event) => options.io.output(serializeEvalEvent(event)));
    return recovered;
  }
};

export { collectEvalEvents, evalEvent, serializeEvalEvent };
