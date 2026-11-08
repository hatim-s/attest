import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { CLI_EVENT_SCHEMA_ID, type CliError, type EvalEvent } from '@attest/contracts';
import { EvalEngineError, safeErrorMessage } from '../errors.js';
import { observe, ordinaryError } from '../lifecycle.js';
import type { ExecuteEvalOptions } from '../types.js';

const MAXIMUM_EVENTS = 100_003;

const MAXIMUM_EVENT_BYTES = 16 * 1024;

type EvalEventBody = EvalEvent extends infer Event
  ? Event extends EvalEvent
    ? Omit<Event, 'schema' | 'sequence' | 'time'>
    : never
  : never;

type EventCollector = {
  events: EvalEvent[];
  causes: Cause.Cause<Error>[];
  emit: (event: EvalEventBody) => Effect.Effect<void, Error>;
  sinkFailure: () => CliError | undefined;
};

/** Collects bounded events and joins delivery once, stopping delivery after its first failure. */
const createEventCollector = (
  now: () => string,
  onEvent: ExecuteEvalOptions['onEvent'],
): EventCollector => {
  const events: EvalEvent[] = [];
  const causes: Cause.Cause<Error>[] = [];
  let deliveryFailure: CliError | undefined;

  const emit = (event: EvalEventBody) =>
    Effect.gen(function* () {
      if (events.length >= MAXIMUM_EVENTS)
        return yield* new EvalEngineError({ reason: 'event_count_cap' });

      const completeEvent: EvalEvent = {
        ...event,
        schema: CLI_EVENT_SCHEMA_ID,
        sequence: events.length,
        time: now(),
      };

      if (Buffer.byteLength(JSON.stringify(completeEvent), 'utf8') > MAXIMUM_EVENT_BYTES)
        return yield* new EvalEngineError({ reason: 'event_byte_cap' });
      events.push(completeEvent);

      if (onEvent === undefined || deliveryFailure !== undefined) return;
      const exit = yield* observe(() => onEvent(completeEvent));

      if (Exit.isFailure(exit)) {
        causes.push(exit.cause);
        deliveryFailure = {
          code: 'eval_event_delivery_failed',
          message: safeErrorMessage(ordinaryError(exit.cause), 'Eval event delivery failed.'),
          retryable: false,
        };
      }
    });

  return { events, causes, emit, sinkFailure: () => deliveryFailure };
};

export { createEventCollector, MAXIMUM_EVENTS, type EventCollector };
