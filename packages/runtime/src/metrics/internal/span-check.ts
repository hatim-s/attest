import { isDeepStrictEqual } from 'node:util';

import type { Span, SpanFilter, Trace } from '@attest/contracts';

import type { CheckEvaluation, LeafCheck } from './leaf-check.js';

/** Orders spans by start instant, keeping document order for equal or unparseable timestamps. */
const orderSpans = (spans: Span[]): Span[] =>
  spans
    .map((span, index) => ({ span, index, startedAt: Date.parse(span.start_time) }))
    .sort((left, right) => {
      const difference = left.startedAt - right.startedAt;
      return difference === 0 || Number.isNaN(difference) ? left.index - right.index : difference;
    })
    .map(({ span }) => span);

/** Applies stable span fields and partial exact attribute matching. */
const spanMatchesFilter = (span: Span, filter: SpanFilter): boolean =>
  (filter.kind === undefined || span.kind === filter.kind) &&
  (filter.name === undefined || span.name === filter.name) &&
  (filter.status === undefined || span.status.code === filter.status) &&
  (filter.attributes === undefined ||
    Object.entries(filter.attributes).every(([name, value]) =>
      isDeepStrictEqual(span.attributes?.[name], value),
    ));

/** Evaluates a declarative span filter, exact count, and chronological name sequence. */
const evaluateSpansCheck = (check: LeafCheck<'spans'>, trace: Trace | null): CheckEvaluation => {
  if (trace === null) return { passed: false, reason: 'no trace emitted' };
  const candidates = orderSpans(trace.spans).filter(
    (span) => check.filter === undefined || spanMatchesFilter(span, check.filter),
  );
  if (
    check.filter !== undefined &&
    check.count === undefined &&
    check.order === undefined &&
    candidates.length === 0
  ) {
    return { passed: false, reason: 'no spans matched the filter' };
  }
  if (check.count !== undefined && candidates.length !== check.count) {
    return {
      passed: false,
      reason: `expected ${check.count} matching spans but found ${candidates.length}`,
    };
  }
  if (
    check.order !== undefined &&
    !isDeepStrictEqual(
      candidates.map((span) => span.name),
      check.order,
    )
  ) {
    return { passed: false, reason: 'span order did not match the expected sequence' };
  }
  return { passed: true };
};

export { evaluateSpansCheck, orderSpans };
