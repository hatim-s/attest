import type { z } from 'zod';

import {
  agentRequestSchema,
  agentResponseSchema,
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
import { err, ok, type Result } from '../result.js';
import { traceSchema, type Trace } from '../trace/protocol.js';
import { type WarningCode } from '../eval/execution.js';

/** Describes a recoverable extension or optional-payload problem. */
type ContractWarning = {
  path: string;
  message: string;
  code: WarningCode;
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
    .filter((fieldName) => !Object.hasOwn(agentResponseSchema.shape, fieldName))
    .map((fieldName) => ({
      path: fieldName,
      message: `unknown top-level response field preserved: ${fieldName}`,
      code: 'unknown_field',
    }));
};

const reportInvalidTrace = (issues: ContractIssue[]): ContractWarning => ({
  path: 'trace',
  message: `invalid trace: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
  code: 'invalid_trace',
});

/**
 * Validates an agent request without throwing, so transports can report contract issues as data.
 */
const parseAgentRequest = (candidate: unknown): Result<AgentRequest, ContractIssue[]> =>
  parseWithSchema(agentRequestSchema, candidate);

/**
 * Validates an agent response without throwing. The trace is optional evidence, so a malformed
 * trace is dropped with a warning instead of failing an otherwise usable response.
 */
const parseAgentResponse = (candidate: unknown): ParseReport<AgentResponse> => {
  const warnings = reportUnknownAgentResponseFields(candidate);
  const parsed = agentResponseSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, errors: formatContractIssues(parsed.error.issues), warnings };
  }

  const { trace, ...fields } = parsed.data;
  // The schema refinement guarantees exactly one of output or error.
  const response = fields as AgentResponse;
  if (trace === undefined) {
    return { ok: true, value: response, warnings };
  }

  const parsedTrace = parseTrace(trace);
  if (!parsedTrace.ok) {
    return {
      ok: true,
      value: response,
      warnings: [...warnings, reportInvalidTrace(parsedTrace.error)],
    };
  }

  return { ok: true, value: { ...response, trace: parsedTrace.value }, warnings };
};

/** Validates a trace document without throwing; extension fields are preserved. */
const parseTrace = (candidate: unknown): Result<Trace, ContractIssue[]> =>
  parseWithSchema(traceSchema, candidate);

/** Validates an executable metric request without throwing. */
const parseMetricRequest = (candidate: unknown): Result<MetricRequest, ContractIssue[]> =>
  parseWithSchema(metricRequestSchema, candidate);

/** Validates a metric result envelope without throwing. */
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
