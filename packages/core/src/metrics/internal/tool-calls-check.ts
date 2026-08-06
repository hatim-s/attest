import type { LeafAssertionCheck, Trace } from '@attest/contracts';

import { isDeepEqual } from './deep-equal.js';

type CheckEvaluation = { passed: boolean; reason?: string };
type ToolCallsCheck = Extract<LeafAssertionCheck, { tool_calls: unknown }>['tool_calls'];

/** Orders tool spans by their parsed instant and preserves trace order when instants are equal. */
const orderToolSpans = (trace: Trace) =>
  trace.spans
    .map((span, index) => ({ span, index }))
    .filter(({ span }) => span.kind === 'tool')
    .sort((left, right) => {
      const timeDifference = Date.parse(left.span.start_time) - Date.parse(right.span.start_time);
      return timeDifference === 0 || Number.isNaN(timeDifference)
        ? left.index - right.index
        : timeDifference;
    })
    .map(({ span }) => span);

/** Evaluates v0 tool span name, status, count, and chronological order without treating no trace as an error. */
const evaluateToolCallsCheck = (check: ToolCallsCheck, trace: Trace | null): CheckEvaluation => {
  if (trace === null) {
    return { passed: false, reason: 'no trace emitted' };
  }

  const chronologicalTools = orderToolSpans(trace);
  const candidates =
    check.name === undefined
      ? chronologicalTools
      : chronologicalTools.filter((span) => span.name === check.name);
  const hasOnlyNameFilter =
    check.name !== undefined &&
    check.status === undefined &&
    check.count === undefined &&
    check.order === undefined;

  if (candidates.length === 0 && hasOnlyNameFilter) {
    return { passed: false, reason: `tool never called: ${check.name}` };
  }
  if (check.status !== undefined && candidates.some((span) => span.status.code !== check.status)) {
    return { passed: false, reason: `not every matching tool call had status ${check.status}` };
  }
  if (check.count !== undefined && candidates.length !== check.count) {
    return {
      passed: false,
      reason: `expected ${check.count} matching tool calls but found ${candidates.length}`,
    };
  }
  if (
    check.order !== undefined &&
    !isDeepEqual(
      candidates.map((span) => span.name),
      check.order,
    )
  ) {
    return { passed: false, reason: 'tool call order did not match the expected sequence' };
  }

  return { passed: true };
};

export { evaluateToolCallsCheck };
