import type { LeafAssertionCheck, Span, SpanFilter, Trace } from '@attest/contracts';

import { isDeepEqual } from './deep-equal.js';

type CheckEvaluation = { passed: boolean; reason?: string };
type SpansCheck = Extract<LeafAssertionCheck, { spans: unknown }>['spans'];

/** Orders spans by start instant and retains document order for equal timestamps. */
const orderSpans = (spans: Span[]): Span[] =>
  spans
    .map((span, index) => ({ span, index }))
    .sort((left, right) => {
      const difference = Date.parse(left.span.start_time) - Date.parse(right.span.start_time);
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
      isDeepEqual(span.attributes?.[name], value),
    ));

/** Evaluates a declarative span filter, exact count, and chronological name sequence. */
const evaluateSpansCheck = (check: SpansCheck, trace: Trace | null): CheckEvaluation => {
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
    !isDeepEqual(
      candidates.map((span) => span.name),
      check.order,
    )
  ) {
    return { passed: false, reason: 'span order did not match the expected sequence' };
  }
  return { passed: true };
};

export { evaluateSpansCheck, orderSpans, spanMatchesFilter };
