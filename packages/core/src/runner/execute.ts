import {
  AttestError,
  type CaseDefinition,
  type Config,
  type ContractIssue,
  type Suite,
} from '@attest/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadDatasetCases } from './dataset.js';
import { mapBounded } from './internal/concurrency-pool.js';
import { invokeAgent } from './invoke.js';
import { buildAgentRequest, resolveInvocationEnv } from './request.js';
import type { CaseExecution, ExecuteOptions, InvocationResult } from './types.js';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_OUTPUT_CAP_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

type ResolvedCase = {
  caseDefinition: CaseDefinition;
  expectedMetrics: string[];
  suiteName: string;
};

class ConfigInvalidError extends AttestError {
  constructor(message: string) {
    super('config_invalid', message);
  }
}

const formatIssues = (issues: ContractIssue[]): string => {
  return issues.map((entry) => `${entry.path}: ${entry.message}`).join('; ');
};

const loadSuiteCases = async (suite: Suite, baseDirectory: string): Promise<CaseDefinition[]> => {
  if ('cases' in suite) {
    return suite.cases;
  }

  const loaded = await loadDatasetCases(suite.dataset, baseDirectory);
  if (!loaded.ok) {
    throw new ConfigInvalidError(
      `Invalid dataset for suite ${suite.name}: ${formatIssues(loaded.error)}`,
    );
  }
  return loaded.value;
};

const resolveCases = async (config: Config, baseDirectory: string): Promise<ResolvedCase[]> => {
  const resolved: ResolvedCase[] = [];
  for (const suite of config.suites) {
    const cases = await loadSuiteCases(suite, baseDirectory);
    for (const caseDefinition of cases) {
      resolved.push({
        caseDefinition,
        expectedMetrics: caseDefinition.metrics ?? suite.metrics,
        suiteName: suite.name,
      });
    }
  }
  return resolved;
};

const invocationOutcome = (
  result: Extract<InvocationResult, { status: 'invocation_error' }>,
): CaseExecution['outcome'] => {
  if (result.error.code === 'timeout' || result.error.code === 'cancelled') {
    return result.error.code;
  }
  return 'invocation_error';
};

const elapsedMilliseconds = (startedAt: number): number => {
  return Math.max(0, performance.now() - startedAt);
};

const executeCase = async (
  resolvedCase: ResolvedCase,
  config: Config,
  options: ExecuteOptions,
): Promise<CaseExecution> => {
  const startedAt = new Date().toISOString();
  const startedAtPerformance = performance.now();
  const { caseDefinition, expectedMetrics, suiteName } = resolvedCase;
  const request = buildAgentRequest(options.runId, caseDefinition);
  const workingDirectory = await mkdtemp(join(tmpdir(), 'attest-'));

  try {
    const result = await invokeAgent(config.agent, request, {
      env: resolveInvocationEnv(config.agent.env, process.env, {
        runId: options.runId,
        caseId: caseDefinition.id,
      }),
      outputCapBytes: config.run?.output_cap_bytes ?? DEFAULT_OUTPUT_CAP_BYTES,
      retries: config.agent.retries ?? 0,
      signal: options.signal,
      terminationGraceMs: options.terminationGraceMs,
      timeoutMs: config.agent.timeout_ms ?? config.run?.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      workingDirectory,
    });

    const common = {
      attempts: result.attempts,
      caseId: caseDefinition.id,
      diagnostics: result.diagnostics,
      durationMs: elapsedMilliseconds(startedAtPerformance),
      expectedMetrics: [...expectedMetrics],
      request,
      startedAt,
      suiteName,
    };
    if (result.status === 'invocation_error') {
      return {
        ...common,
        invocationError: result.error,
        outcome: invocationOutcome(result),
        warnings: [],
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
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
};

/**
 * Executes every config case with bounded completion-order delivery, fail-fast dataset loading,
 * progress reporting, and response ingestion as specified by docs/specs/agent-contract.md and
 * docs/specs/config-format.md.
 */
async function* executeCases(
  config: Config,
  options: ExecuteOptions,
): AsyncIterable<CaseExecution> {
  // Resolve every dataset before starting the pool so invalid configuration cannot partially run.
  const resolvedCases = await resolveCases(config, options.baseDirectory);
  const concurrency = options.concurrency ?? config.run?.concurrency ?? DEFAULT_CONCURRENCY;
  let completed = 0;
  const executions = mapBounded(
    resolvedCases,
    concurrency,
    (resolvedCase) => executeCase(resolvedCase, config, options),
    { signal: options.signal },
  );

  for await (const { result } of executions) {
    completed += 1;
    options.onProgress?.({ completed, total: resolvedCases.length, execution: result });
    yield result;
  }
}

/**
 * Collects the completion-order stream from executeCases for consumers that need an array while
 * preserving the execution semantics in docs/specs/agent-contract.md.
 */
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
