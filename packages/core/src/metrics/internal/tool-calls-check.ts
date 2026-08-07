import type {
  JsonValue,
  LeafAssertionCheck,
  Span,
  ToolArgumentMatcher,
  Trace,
} from '@attest/contracts';

import { resolveValuePath } from '../evaluation-document.js';
import { isDeepEqual } from './deep-equal.js';
import { orderSpans } from './span-check.js';

type CheckEvaluation = { passed: boolean; reason?: string };
type ToolCallsCheck = Extract<LeafAssertionCheck, { tool_calls: unknown }>['tool_calls'];

/** Narrows parsed JSON while rejecting the non-finite numbers JSON.parse can produce from exponents. */
const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
};

/** Uses the OTel semantic tool name when present and falls back to the human span name. */
const toolName = (span: Span): string => {
  const semanticName = span.attributes?.['gen_ai.tool.name'];
  return typeof semanticName === 'string' ? semanticName : span.name;
};

/** Parses the standardized JSON-string argument attribute, then falls back to structured span input. */
const readToolArguments = (span: Span): JsonValue | undefined => {
  const serialized = span.attributes?.['gen_ai.tool.call.arguments'];
  if (typeof serialized === 'string') {
    try {
      const parsed: unknown = JSON.parse(serialized);
      return isJsonValue(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return span.input;
};

/** Evaluates one structural equality, containment, or presence matcher over parsed arguments. */
const matchesToolArgument = (argumentsValue: JsonValue, matcher: ToolArgumentMatcher): boolean => {
  const check =
    'equals' in matcher
      ? matcher.equals
      : 'contains' in matcher
        ? matcher.contains
        : matcher.exists;
  const resolution = resolveValuePath(argumentsValue, check.path);
  if ('exists' in matcher) return resolution.found;
  if (!resolution.found) return false;
  if ('equals' in matcher) return isDeepEqual(resolution.value, matcher.equals.value);
  if (typeof resolution.value === 'string' && typeof matcher.contains.value === 'string') {
    return resolution.value.includes(matcher.contains.value);
  }
  return (
    Array.isArray(resolution.value) &&
    resolution.value.some((value) => isDeepEqual(value, matcher.contains.value))
  );
};

/** Evaluates tool name, status, count, order, and structured argument evidence. */
const evaluateToolCallsCheck = (check: ToolCallsCheck, trace: Trace | null): CheckEvaluation => {
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
  if (check.order !== undefined && !isDeepEqual(candidates.map(toolName), check.order)) {
    return { passed: false, reason: 'tool call order did not match the expected sequence' };
  }
  if (
    check.arguments !== undefined &&
    !candidates.some((span) => {
      const argumentsValue = readToolArguments(span);
      return (
        argumentsValue !== undefined &&
        check.arguments?.every((matcher) => matchesToolArgument(argumentsValue, matcher)) === true
      );
    })
  ) {
    return {
      passed: false,
      reason: 'no matching tool call arguments satisfied every argument matcher',
    };
  }

  return { passed: true };
};

export { evaluateToolCallsCheck, matchesToolArgument, readToolArguments, toolName };
