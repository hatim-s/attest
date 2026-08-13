import type { z } from 'zod';

import {
  agentRequestSchema,
  agentResponseSchema,
  agentResponseValueSchema,
  type AgentRequest,
  type AgentResponse,
} from '../agent/protocol.js';
import { formatContractIssues, type ContractIssue } from '../internal/issues.js';
import {
  metricRequestSchema,
  metricResultSchema,
  type MetricRequest,
  type MetricResult,
} from '../metric/protocol.js';
import { err, ok, type Result } from '../cli/result.js';
import { traceSchema, type Trace } from '../trace/protocol.js';

const AGENT_RESPONSE_FIELDS = new Set(['protocol', 'output', 'error', 'state', 'trace']);

/** Describes a recoverable extension or optional-payload problem. */
type ContractWarning = {
  path: string;
  message: string;
  code: 'unknown_field' | 'invalid_trace';
};

/** Reports successful parsing and recoverable warnings without conflating them with errors. */
type ParseReport<T> =
  | { ok: true; value: T; warnings: ContractWarning[] }
  | { ok: false; errors: ContractIssue[]; warnings: ContractWarning[] };

const parseWithSchema = <T>(
  schema: z.ZodType<T>,
  candidate: unknown,
): Result<T, ContractIssue[]> => {
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    return err(formatContractIssues(parsed.error.issues));
  }

  return ok(parsed.data);
};

const reportUnknownAgentResponseFields = (candidate: unknown): ContractWarning[] => {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return [];
  }

  return Object.keys(candidate)
    .filter((fieldName) => !AGENT_RESPONSE_FIELDS.has(fieldName))
    .map((fieldName) => ({
      path: fieldName,
      message: `unknown top-level response field preserved: ${fieldName}`,
      code: 'unknown_field' as const,
    }));
};

const reportInvalidTrace = (issues: ContractIssue[]): ContractWarning => ({
  path: 'trace',
  message: `invalid trace: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
  code: 'invalid_trace',
});

const reportAgentOutcomeIssue = (candidate: unknown): ContractIssue[] | undefined => {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }

  const outcomeCount = ['output', 'error'].filter((fieldName) =>
    Object.hasOwn(candidate, fieldName),
  ).length;
  if (outcomeCount === 1) {
    return undefined;
  }

  return [{ path: 'output', message: 'exactly one of output or error must be present' }];
};

const omitUnvalidatedTrace = <T extends { trace?: unknown }>(response: T): Omit<T, 'trace'> => {
  const responseWithoutTrace = { ...response };
  delete responseWithoutTrace.trace;
  return responseWithoutTrace;
};

/** Validates an agent request against docs/specs/agent-contract.md without throwing. */
const parseAgentRequest = (candidate: unknown): Result<AgentRequest, ContractIssue[]> =>
  parseWithSchema(agentRequestSchema, candidate);

/**
 * Validates an agent response while degrading malformed optional traces into warnings.
 */
const parseAgentResponse = (candidate: unknown): ParseReport<AgentResponse> => {
  const warnings = reportUnknownAgentResponseFields(candidate);
  const parsedEnvelope = agentResponseSchema.safeParse(candidate);
  if (!parsedEnvelope.success) {
    return {
      ok: false,
      errors:
        reportAgentOutcomeIssue(candidate) ?? formatContractIssues(parsedEnvelope.error.issues),
      warnings,
    };
  }

  const response = omitUnvalidatedTrace(parsedEnvelope.data);
  const hasTrace =
    candidate !== null &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    Object.hasOwn(candidate, 'trace');
  if (!hasTrace) {
    const parsedValue = agentResponseValueSchema.safeParse(response);
    if (!parsedValue.success) {
      return { ok: false, errors: formatContractIssues(parsedValue.error.issues), warnings };
    }

    const value: AgentResponse = { ...response, ...parsedValue.data };
    return { ok: true, value, warnings };
  }

  const parsedTrace = parseTrace(Reflect.get(candidate, 'trace'));
  if (!parsedTrace.ok) {
    warnings.push(reportInvalidTrace(parsedTrace.error));
  }

  const trace = parsedTrace.ok ? parsedTrace.value : undefined;
  const parsedValue = agentResponseValueSchema.safeParse({ ...response, trace });
  if (!parsedValue.success) {
    return { ok: false, errors: formatContractIssues(parsedValue.error.issues), warnings };
  }

  const value: AgentResponse = { ...response, ...parsedValue.data };
  return { ok: true, value, warnings };
};

/** Validates and losslessly parses docs/specs/trace-schema.md documents without throwing. */
const parseTrace = (candidate: unknown): Result<Trace, ContractIssue[]> =>
  parseWithSchema(traceSchema, candidate);

/** Validates executable metric requests from docs/specs/metric-contract.md without throwing. */
const parseMetricRequest = (candidate: unknown): Result<MetricRequest, ContractIssue[]> =>
  parseWithSchema(metricRequestSchema, candidate);

/** Validates docs/specs/metric-contract.md result envelopes without throwing. */
const parseMetricResult = (candidate: unknown): Result<MetricResult, ContractIssue[]> =>
  parseWithSchema(metricResultSchema, candidate);

export {
  parseAgentRequest,
  parseAgentResponse,
  parseMetricRequest,
  parseMetricResult,
  parseTrace,
  type ContractIssue,
  type ContractWarning,
  type ParseReport,
};
