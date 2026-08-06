import type { z } from 'zod';

import { agentResponseSchema, type AgentResponse } from './agent.js';
import { configSchema, type Config } from './config.js';
import { formatContractIssues } from './internal/issues.js';
import { metricResultSchema, type MetricResult } from './metric.js';
import { err, ok, type Result } from './result.js';
import { traceSchema, type Trace } from './trace.js';

/** Describes one actionable contract violation without exposing Zod in the public error shape. */
type ContractIssue = { path: string; message: string };

const parseWithSchema = <T>(schema: z.ZodType<T>, data: unknown): Result<T, ContractIssue[]> => {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return err(formatContractIssues(parsed.error.issues));
  }

  return ok(parsed.data);
};

/** Validates an agent result against docs/specs/agent-contract.md without throwing. */
const parseAgentResponse = (data: unknown): Result<AgentResponse, ContractIssue[]> =>
  parseWithSchema(agentResponseSchema, data);

/** Validates and losslessly parses docs/specs/trace-schema.md documents without throwing. */
const parseTrace = (data: unknown): Result<Trace, ContractIssue[]> =>
  parseWithSchema(traceSchema, data);

/** Validates a strict docs/specs/config-format.md v1 document without throwing. */
const parseConfig = (data: unknown): Result<Config, ContractIssue[]> =>
  parseWithSchema(configSchema, data);

/** Validates docs/specs/metric-contract.md result envelopes without throwing. */
const parseMetricResult = (data: unknown): Result<MetricResult, ContractIssue[]> =>
  parseWithSchema(metricResultSchema, data);

export { parseAgentResponse, parseConfig, parseMetricResult, parseTrace, type ContractIssue };
