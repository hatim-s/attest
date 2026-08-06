import type { CaseDefinition, CaseOutcome, Config, ContractIssue, Suite } from '@attest/contracts';

import { inspectDatasetCases, type DatasetCaseRecord } from './dataset.js';
import { ConfigInvalidError } from './errors.js';
import { mapBounded } from './internal/concurrency-pool.js';
import { startTimer } from './internal/elapsed.js';
import { invokeAgent } from './invoke.js';
import { buildAgentRequest } from './request.js';
import type { CaseExecution, ExecuteOptions, InvocationResult } from './types.js';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_OUTPUT_CAP_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

type ResolvedCase = {
  caseDefinition: CaseDefinition;
  expectedMetrics: string[];
  suiteName: string;
};

type ResolvedDatasetSuite = { cases: ResolvedCase[]; issues: ContractIssue[] };

const formatIssues = (issues: ContractIssue[]): string => {
  return issues.map(({ path, message }) => `${path}: ${message}`).join('; ');
};

const qualifyDatasetIssue = (suiteIndex: number, issue: ContractIssue): ContractIssue => ({
  path: `suites[${String(suiteIndex)}].dataset ${issue.path}`,
  message: issue.message,
});

const reportDatasetMetricReferences = (
  records: readonly DatasetCaseRecord[],
  metricNames: ReadonlySet<string>,
  suiteIndex: number,
): ContractIssue[] => {
  return records.flatMap(({ caseDefinition, lineNumber }) =>
    (caseDefinition.metrics ?? []).flatMap((metricName, metricIndex) =>
      metricNames.has(metricName)
        ? []
        : [
            {
              path: `suites[${String(suiteIndex)}].dataset line ${String(lineNumber)}.metrics.${String(metricIndex)}`,
              message: `metric is not defined: ${metricName}`,
            },
          ],
    ),
  );
};

const toResolvedCases = (suite: Suite, records: readonly DatasetCaseRecord[]): ResolvedCase[] => {
  return records.map(({ caseDefinition }) => ({
    caseDefinition,
    expectedMetrics: caseDefinition.metrics ?? suite.metrics,
    suiteName: suite.name,
  }));
};

const resolveDatasetSuite = async (
  suite: Suite,
  suiteIndex: number,
  baseDirectory: string,
  metricNames: ReadonlySet<string>,
): Promise<ResolvedDatasetSuite> => {
  if ('cases' in suite) {
    return { cases: [], issues: [] };
  }

  const inspection = await inspectDatasetCases(suite.dataset, baseDirectory);
  return {
    cases: toResolvedCases(suite, inspection.records),
    issues: [
      ...inspection.issues.map((issue) => qualifyDatasetIssue(suiteIndex, issue)),
      ...reportDatasetMetricReferences(inspection.records, metricNames, suiteIndex),
    ],
  };
};

/** Resolves all dataset suites before returning any work, aggregating every config error in one throw. */
const resolveCases = async (config: Config, baseDirectory: string): Promise<ResolvedCase[]> => {
  const metricNames = new Set(config.metrics.map(({ name }) => name));
  const datasetSuites = await Promise.all(
    config.suites.map((suite, suiteIndex) =>
      resolveDatasetSuite(suite, suiteIndex, baseDirectory, metricNames),
    ),
  );
  const issues = datasetSuites.flatMap(({ issues: suiteIssues }) => suiteIssues);
  if (issues.length > 0) {
    throw new ConfigInvalidError(`Configuration is invalid: ${formatIssues(issues)}`, issues);
  }

  return config.suites.flatMap((suite, suiteIndex) => {
    if ('cases' in suite) {
      return toResolvedCases(
        suite,
        suite.cases.map((caseDefinition, caseIndex) => ({
          caseDefinition,
          lineNumber: caseIndex + 1,
        })),
      );
    }

    return datasetSuites[suiteIndex]?.cases ?? [];
  });
};

const invocationOutcome = (
  result: Extract<InvocationResult, { status: 'invocation_error' }>,
): Exclude<CaseOutcome, 'completed'> => {
  return result.error.code === 'timeout' || result.error.code === 'cancelled'
    ? result.error.code
    : 'invocation_error';
};

const executeCase = async (
  resolvedCase: ResolvedCase,
  config: Config,
  options: ExecuteOptions,
): Promise<CaseExecution> => {
  const startedAt = new Date().toISOString();
  const duration = startTimer();
  const { caseDefinition, expectedMetrics, suiteName } = resolvedCase;
  const request = buildAgentRequest(options.runId, caseDefinition);
  const result = await invokeAgent(config.agent, request, {
    envAllowlist: config.agent.env,
    outputCapBytes: config.run?.output_cap_bytes ?? DEFAULT_OUTPUT_CAP_BYTES,
    retries: config.agent.retries ?? 0,
    signal: options.signal,
    timeoutMs: config.agent.timeout_ms ?? config.run?.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  });
  const common = {
    attempts: result.attempts,
    caseDefinition,
    caseId: caseDefinition.id,
    diagnostics: result.diagnostics,
    durationMs: duration(),
    expectedMetrics: [...expectedMetrics],
    request,
    startedAt,
    suiteName,
    warnings: result.warnings,
  };
  if (result.status === 'invocation_error') {
    return {
      ...common,
      invocationError: result.error,
      outcome: invocationOutcome(result),
    };
  }

  const report = result.report;
  if (report === undefined || !report.ok) {
    throw new TypeError('invokeAgent returned an unvalidated successful response');
  }

  return {
    ...common,
    outcome: 'completed',
    response: report.value,
    trace: report.value.trace,
    warnings: report.warnings,
  };
};

/**
 * Executes all validated cases with bounded completion-order delivery and pool-owned cancellation,
 * following docs/specs/agent-contract.md and docs/specs/config-format.md.
 */
async function* executeCases(
  config: Config,
  options: ExecuteOptions,
): AsyncIterable<CaseExecution> {
  const resolvedCases = await resolveCases(config, options.baseDirectory);
  const concurrency = options.concurrency ?? config.run?.concurrency ?? DEFAULT_CONCURRENCY;
  let completed = 0;
  const executions = mapBounded(
    resolvedCases,
    concurrency,
    (resolvedCase, _index, signal) => executeCase(resolvedCase, config, { ...options, signal }),
    { signal: options.signal },
  );

  for await (const { result } of executions) {
    completed += 1;
    options.onProgress?.({ completed, total: resolvedCases.length, execution: result });
    yield result;
  }
}

/** Collects the completion-order execution stream for array-oriented consumers. */
const collectExecutions = async (
  config: Config,
  options: ExecuteOptions,
): Promise<CaseExecution[]> => {
  const executions: CaseExecution[] = [];
  for await (const execution of executeCases(config, options)) {
    executions.push(execution);
  }
  return executions;
};

export { collectExecutions, executeCases };
