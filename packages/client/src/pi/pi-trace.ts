import {
  TRACE_SCHEMA_ID,
  type JsonValue,
  type Span,
  type SpanKind,
  type Trace,
} from '@attest/contracts';
import { randomUUID } from 'node:crypto';

import { assistantText, toolResultText, type PiRecord } from './pi-records.js';

// A run with more spans than this is runaway tool looping; later spans are counted, not kept.
const MAX_SPANS = 1_000;

const MAX_ROOT_EVENTS = 100;

// Tool arguments and results above this size are left out of the trace rather than truncated,
// because a truncated JSON string no longer parses for argument matchers.
const MAX_PAYLOAD_CHARS = 64 * 1024;

const MAX_STATUS_MESSAGE_CHARS = 1_024;

type Attributes = Record<string, string | number | boolean>;

type SpanDraft = {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: SpanKind;
  start: number;
  end: number | undefined;
  error: string | undefined;
  attributes: Attributes;
  events: { name: string; time: number; attributes: Attributes }[];
  output: JsonValue | undefined;
};

type PiTraceBuilder = {
  /** Folds one stdout record into the span tree, timestamped on arrival. */
  record: (record: PiRecord) => void;
  /** Adds a point event to the root span. */
  note: (name: string, attributes: Attributes) => void;
  /** Closes open spans and returns the trace, or `undefined` if Pi never started a run. */
  finish: (failure: string | undefined) => Trace | undefined;
};

const boundedJson = (value: JsonValue): string | undefined => {
  const text = JSON.stringify(value);

  return text.length <= MAX_PAYLOAD_CHARS ? text : undefined;
};

const toSpan = (draft: SpanDraft): Span => {
  const span: Span = {
    span_id: draft.span_id,
    parent_span_id: draft.parent_span_id,
    name: draft.name,
    kind: draft.kind,
    start_time: new Date(draft.start).toISOString(),
    // Receipt times can step backwards with the wall clock; the schema requires end >= start.
    end_time: new Date(Math.max(draft.start, draft.end ?? draft.start)).toISOString(),
    status: draft.error === undefined ? { code: 'ok' } : { code: 'error', message: draft.error },
    attributes: draft.attributes,
  };

  if (draft.events.length > 0) {
    span.events = draft.events.map((event) => ({
      name: event.name,
      time: new Date(event.time).toISOString(),
      attributes: event.attributes,
    }));
  }

  if (draft.output !== undefined) span.output = draft.output;

  return span;
};

/**
 * Builds an `attest.trace` from Pi RPC records: a root `agent.run` span from `agent_start` to
 * `agent_settled`, an `llm.call` span per turn, and a `tool.<name>` span per tool execution under
 * its turn. Retries become events on the root span.
 */
const createPiTraceBuilder = (requestModel: string | undefined): PiTraceBuilder => {
  const spans: SpanDraft[] = [];
  const tools = new Map<string, SpanDraft>();
  let root: SpanDraft | undefined;
  let turn: SpanDraft | undefined;
  let droppedSpans = 0;

  const open = (
    name: string,
    kind: SpanKind,
    parent: SpanDraft | undefined,
    start: number,
  ): SpanDraft | undefined => {
    if (spans.length >= MAX_SPANS) {
      droppedSpans += 1;

      return undefined;
    }

    const draft: SpanDraft = {
      span_id: `span-${String(spans.length + 1)}`,
      parent_span_id: parent?.span_id ?? null,
      name,
      kind,
      start,
      end: undefined,
      error: undefined,
      attributes: {},
      events: [],
      output: undefined,
    };

    spans.push(draft);

    return draft;
  };

  const ensureRoot = (now: number): SpanDraft | undefined => {
    if (root !== undefined) return root;
    root = open('agent.run', 'agent', undefined, now);

    if (root !== undefined) {
      root.attributes['gen_ai.operation.name'] = 'invoke_agent';

      if (requestModel !== undefined) root.attributes['gen_ai.request.model'] = requestModel;
    }

    return root;
  };

  const note = (name: string, attributes: Attributes, now = Date.now()): void => {
    const target = ensureRoot(now);

    if (target !== undefined && target.events.length < MAX_ROOT_EVENTS) {
      target.events.push({ name, time: now, attributes });
    }
  };

  /**
   * Pi's RPC lifecycle records carry no timestamps, so every span boundary and event time here is
   * the local wall-clock time at which the handler received the record, not a time Pi reported.
   */
  const record = (piRecord: PiRecord): void => {
    const now = Date.now();

    switch (piRecord.type) {
      case 'agent_start':
        ensureRoot(now);
        break;
      case 'turn_start':
        turn = open('llm.call', 'llm', ensureRoot(now), now);

        if (turn !== undefined) {
          turn.attributes['gen_ai.operation.name'] = 'chat';

          if (requestModel !== undefined) turn.attributes['gen_ai.request.model'] = requestModel;
        }

        break;
      case 'message_end': {
        const message = piRecord.message;

        if (message === null || turn === undefined) break;
        turn.attributes['gen_ai.response.model'] = message.responseModel ?? message.model;
        turn.attributes['gen_ai.usage.input_tokens'] = message.usage.input;
        turn.attributes['gen_ai.usage.output_tokens'] = message.usage.output;
        turn.output = assistantText(message);

        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          turn.error = (message.errorMessage ?? `stopReason ${message.stopReason}`).slice(
            0,
            MAX_STATUS_MESSAGE_CHARS,
          );
        }

        break;
      }

      case 'turn_end':
        if (turn !== undefined) turn.end = now;
        turn = undefined;
        break;
      case 'tool_execution_start': {
        const tool = open(`tool.${piRecord.toolName}`, 'tool', turn ?? ensureRoot(now), now);

        if (tool === undefined) break;
        tool.attributes['gen_ai.operation.name'] = 'execute_tool';
        tool.attributes['gen_ai.tool.name'] = piRecord.toolName;
        tool.attributes['gen_ai.tool.call.id'] = piRecord.toolCallId;
        const args = boundedJson(piRecord.args);

        if (args !== undefined) tool.attributes['gen_ai.tool.call.arguments'] = args;
        tools.set(piRecord.toolCallId, tool);
        break;
      }

      case 'tool_execution_end': {
        // Without a paired start, Pi's monotonic durationMs gives the best available start.
        const tool =
          tools.get(piRecord.toolCallId) ??
          open(
            `tool.${piRecord.toolName}`,
            'tool',
            turn ?? ensureRoot(now),
            now - (piRecord.durationMs ?? 0),
          );

        if (tool === undefined) break;
        tools.delete(piRecord.toolCallId);
        tool.end = now;
        tool.attributes['gen_ai.tool.name'] = piRecord.toolName;
        tool.attributes['gen_ai.tool.call.id'] = piRecord.toolCallId;

        if (boundedJson(piRecord.result) !== undefined) tool.output = piRecord.result;

        if (piRecord.isError) {
          tool.error = (toolResultText(piRecord.result) ?? 'tool failed').slice(
            0,
            MAX_STATUS_MESSAGE_CHARS,
          );
        }

        break;
      }

      case 'auto_retry_start':
        note(
          'auto_retry_start',
          {
            attempt: piRecord.attempt,
            max_attempts: piRecord.maxAttempts,
            delay_ms: piRecord.delayMs,
            error: piRecord.errorMessage.slice(0, MAX_STATUS_MESSAGE_CHARS),
          },
          now,
        );
        break;
      case 'auto_retry_end':
        note('auto_retry_end', { attempt: piRecord.attempt, success: piRecord.success }, now);
        break;
      case 'agent_settled':
        if (root !== undefined) root.end = now;

        if (piRecord.aborted && root !== undefined) root.error = 'aborted';
        break;
      case 'response':
        break;
    }
  };

  return {
    record,
    note,
    finish: (failure) => {
      if (root === undefined) return undefined;
      const now = Date.now();

      for (const draft of spans) {
        if (draft.end !== undefined) continue;
        draft.end = now;
        draft.error ??= 'did not finish';
      }

      if (failure !== undefined) root.error = failure.slice(0, MAX_STATUS_MESSAGE_CHARS);

      if (droppedSpans > 0) root.attributes['attest.trace.dropped_spans'] = droppedSpans;

      return { schema: TRACE_SCHEMA_ID, trace_id: randomUUID(), spans: spans.map(toSpan) };
    },
  };
};

export { createPiTraceBuilder, type PiTraceBuilder };
