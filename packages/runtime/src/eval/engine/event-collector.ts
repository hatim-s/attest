import { CLI_EVENT_SCHEMA_ID, type CliError, type EvalEvent } from '@attest/contracts';

import { safeErrorMessage } from '../errors.js';
import type { ExecuteEvalOptions } from '../types.js';

const MAXIMUM_EVENTS = 100_003;
const MAXIMUM_EVENT_BYTES = 16 * 1024;

/** An event before the collector stamps its schema, sequence, and time. */
type EvalEventBody = EvalEvent extends infer Event
  ? Event extends EvalEvent
    ? Omit<Event, 'schema' | 'sequence' | 'time'>
    : never
  : never;

type EventCollector = {
  events: EvalEvent[];
  emit: (event: EvalEventBody) => Promise<void>;
  sinkFailure: () => CliError | undefined;
};

/**
 * Collects bounded eval events. Caps are enforced at emit time; a failed caller sink is recorded
 * once and delivery stops, while collection continues so the returned stream stays complete.
 */
const createEventCollector = (
  now: () => string,
  onEvent: ExecuteEvalOptions['onEvent'],
): EventCollector => {
  const events: EvalEvent[] = [];
  let deliveryFailure: CliError | undefined;
  const emit = async (event: EvalEventBody): Promise<void> => {
    if (events.length >= MAXIMUM_EVENTS) throw new Error('Eval event count cap was exceeded.');
    const completeEvent: EvalEvent = {
      ...event,
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: events.length,
      time: now(),
    };
    if (Buffer.byteLength(JSON.stringify(completeEvent), 'utf8') > MAXIMUM_EVENT_BYTES) {
      throw new Error('Eval event byte cap was exceeded.');
    }
    events.push(completeEvent);
    if (onEvent === undefined || deliveryFailure !== undefined) {
      return;
    }
    try {
      await onEvent(completeEvent);
    } catch (error: unknown) {
      deliveryFailure = {
        code: 'eval_event_delivery_failed',
        message: safeErrorMessage(error, 'Eval event delivery failed.'),
        retryable: false,
      };
    }
  };
  return { events, emit, sinkFailure: () => deliveryFailure };
};

export { createEventCollector, MAXIMUM_EVENTS, type EventCollector };
