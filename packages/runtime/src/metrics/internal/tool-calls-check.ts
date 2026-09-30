import { isDeepStrictEqual } from 'node:util';

import type { JsonValue, Span, ToolArgumentMatcher, Trace } from '@attest/contracts';

import { resolveValuePath } from '../evaluation-document.js';
import { isJsonValue } from './json-value.js';
import type { CheckEvaluation, LeafCheck } from './leaf-check.js';
import { orderSpans } from './span-check.js';

/** Uses the OTel semantic tool name when present and falls back to the human span name. */
const toolName = (span: Span): string => {
  const semanticName = span.attributes?.['gen_ai.tool.name'];
  return typeof semanticName === 'string' ? semanticName : span.name;
};

/** Parses the standardized JSON-string argument attribute, then falls back to structured span input. */
const readToolArguments = (span: Span): JsonValue | undefined => {
  const serialized = span.attributes?.['gen_ai.tool.call.arguments'];
  if (typeof serialized !== 'string') {
    return span.input;
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** Evaluates one structural equality, containment, or presence matcher over parsed arguments. */
const matchesToolArgument = (argumentsValue: JsonValue, matcher: ToolArgumentMatcher): boolean => {
  if ('exists' in matcher) {
    return resolveValuePath(argumentsValue, matcher.exists.path).found;
  }
  if ('equals' in matcher) {
    const resolution = resolveValuePath(argumentsValue, matcher.equals.path);
    return resolution.found && isDeepStrictEqual(resolution.value, matcher.equals.value);
  }
  const resolution = resolveValuePath(argumentsValue, matcher.contains.path);
  if (!resolution.found) {
    return false;
  }
  const expected = matcher.contains.value;
  if (typeof resolution.value === 'string' && typeof expected === 'string') {
    return resolution.value.includes(expected);
  }
  return (
    Array.isArray(resolution.value) &&
    resolution.value.some((value) => isDeepStrictEqual(value, expected))
  );
};

/** Evaluates tool name, status, count, order, and structured argument evidence. */
const evaluateToolCallsCheck = (
  check: LeafCheck<'tool_calls'>,
  trace: Trace | null,
): CheckEvaluation => {
  if (trace === null) return { passed: false, reason: 'no trace emitted' };

  const chronologicalTools = orderSpans(trace.spans.filter((span) => span.kind === 'tool'));
  const candidates =
    check.name === undefined
      ? chronologicalTools
      : chronologicalTools.filter((span) => toolName(span) === check.name);
  const hasOnlyNameFilter =
    check.name !== undefined &&
    check.status === undefined &&
    check.count === undefined &&
    check.order === undefined &&
    check.arguments === undefined;

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
  if (check.order !== undefined && !isDeepStrictEqual(candidates.map(toolName), check.order)) {
    return { passed: false, reason: 'tool call order did not match the expected sequence' };
  }

  const matchers = check.arguments;
  if (matchers === undefined) {
    return { passed: true };
  }
  const argumentsMatch = candidates.some((span) => {
    const argumentsValue = readToolArguments(span);
    return (
      argumentsValue !== undefined &&
      matchers.every((matcher) => matchesToolArgument(argumentsValue, matcher))
    );
  });
  if (!argumentsMatch) {
    return {
      passed: false,
      reason: 'no matching tool call arguments satisfied every argument matcher',
    };
  }
  return { passed: true };
};

export { evaluateToolCallsCheck };
