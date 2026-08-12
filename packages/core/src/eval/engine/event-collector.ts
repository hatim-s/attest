import { CLI_EVENT_SCHEMA_ID, type CliError, type EvalEvent } from '@attest/contracts';

import type { EvalEventLimits, ExecuteEvalOptions } from '../types.js';
import { safeErrorMessage } from './run-model.js';

type EventCollector = {
  events: EvalEvent[];
  emit: (event: Omit<EvalEvent, 'schema' | 'sequence' | 'time'>) => Promise<void>;
  sinkFailure: () => CliError | undefined;
};

/** Collects bounded eval events and records the first delivery failure without losing the stream. */
const createEventCollector = (
  now: () => string,
  limits: EvalEventLimits,
  onEvent: ExecuteEvalOptions['onEvent'],
): EventCollector => {
  const events: EvalEvent[] = [];
  let deliveryFailure: CliError | undefined;
  const emit = async (event: Omit<EvalEvent, 'schema' | 'sequence' | 'time'>): Promise<void> => {
    if (events.length >= limits.max_events) throw new Error('Eval event count cap was exceeded.');
    const completeEvent = {
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: events.length,
      time: now(),
      ...event,
    } as EvalEvent;
    if (Buffer.byteLength(JSON.stringify(completeEvent), 'utf8') > limits.max_event_bytes) {
      throw new Error('Eval event byte cap was exceeded.');
    }
    events.push(completeEvent);
    if (onEvent !== undefined && deliveryFailure === undefined) {
      try {
        await onEvent(completeEvent);
      } catch (error: unknown) {
        deliveryFailure = {
          code: 'eval_event_delivery_failed',
          message: safeErrorMessage(error, 'Eval event delivery failed.'),
          retryable: false,
        };
      }
    }
  };
  return { events, emit, sinkFailure: () => deliveryFailure };
};

export { createEventCollector, type EventCollector };
