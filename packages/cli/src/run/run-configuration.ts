import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { MetricDefinition } from '@attest/contracts';
import {
  caseExecutionToMetricContext,
  createTanstackJudgeClient,
  diffRuns,
  evaluateMetrics,
  executeCases,
  openStore,
  toStoredCaseExecution,
  toStoredMetricEvaluation,
  type CaseRecord,
  type CacheStore,
  type JudgeCache,
  type JudgeCacheEntry,
  type JudgeClient,
  type RunDiff,
  type RunRecord,
  type RunProgressEvent,
} from '@attest/core';

import { AttestCliError } from '../errors.js';
import type { LoadedConfig } from '../config/load-config.js';
import { resolveAgentTarget } from '../config/resolve-agent-target.js';

type RunConfigurationOptions = {
  baselineRunId?: string;
  judgeClient?: JudgeClient;
  onProgress?: (event: RunProgressEvent) => void;
  signal?: AbortSignal;
  storePath?: string;
};

/** Adapts the shared SQLite response cache to the judge metric's typed cache boundary. */
const createJudgeCache = (cacheStore: CacheStore): JudgeCache => ({
  get: async (key) => (await cacheStore.get('judge', key)) as JudgeCacheEntry | undefined,
  set: (key, entry) => cacheStore.put('judge', key, entry),
});

type RunExecutionResult = {
  cases: CaseRecord[];
  diff?: RunDiff;
  run: RunRecord;
  storePath: string;
};

const selectMetricDefinitions = (
  expectedMetrics: readonly string[],
  definitionsByName: ReadonlyMap<string, MetricDefinition>,
): MetricDefinition[] =>
  expectedMetrics.map((metricName) => {
    const definition = definitionsByName.get(metricName);
    if (definition === undefined) {
      throw new AttestCliError(
        'run_failed',
        `Metric ${metricName} disappeared after config validation. Re-run with an unchanged config.`,
      );
    }
    return definition;
  });

/** Executes one validated config through runner, metrics, durable store, and optional baseline diff. */
const runConfiguration = async (
  loadedConfig: LoadedConfig,
  options: RunConfigurationOptions = {},
): Promise<RunExecutionResult> => {
  const storePath = resolve(loadedConfig.baseDirectory, options.storePath ?? '.attest/runs.db');
  await mkdir(dirname(storePath), { recursive: true });

  const store = await openStore(storePath);
  let run: RunRecord | undefined;
  try {
    if (options.baselineRunId !== undefined) {
      // Validate the baseline before creating a run that would otherwise fail after finalization.
      await store.runs.getRun(options.baselineRunId);
    }
    run = await store.runs.createRun({
      configVersion: String(loadedConfig.config.config_version),
      configHash: loadedConfig.configHash,
      configJson: loadedConfig.canonicalJson,
    });
    const definitionsByName = new Map(
      loadedConfig.config.metrics.map((definition) => [definition.name, definition]),
    );
    const hasJudgeMetrics = loadedConfig.config.metrics.some(
      (definition) => definition.type === 'judge',
    );
    const judgeClient = hasJudgeMetrics
      ? (options.judgeClient ?? createTanstackJudgeClient())
      : undefined;
    const judgeCache = hasJudgeMetrics ? createJudgeCache(store.cache) : undefined;
    const executionConfig = resolveAgentTarget(loadedConfig.config, loadedConfig.baseDirectory);

    for await (const execution of executeCases(executionConfig, {
      runId: run.id,
      baseDirectory: loadedConfig.baseDirectory,
      signal: options.signal,
      onProgress: options.onProgress,
    })) {
      const definitions = selectMetricDefinitions(execution.expectedMetrics, definitionsByName);
      const evaluations = await evaluateMetrics(
        definitions,
        caseExecutionToMetricContext(execution.caseDefinition, execution),
        { cache: judgeCache, judgeClient, signal: options.signal },
      );
      await store.runs.recordCase(
        run.id,
        toStoredCaseExecution(execution),
        evaluations.map(toStoredMetricEvaluation),
      );
    }

    const completedRun = await store.runs.finalizeRun(run.id, 'completed');
    run = completedRun;
    const cases = await store.runs.getCaseResults(run.id);
    const diff =
      options.baselineRunId === undefined
        ? undefined
        : await diffRuns(store.runs, options.baselineRunId, run.id);
    return { cases, diff, run: completedRun, storePath };
  } catch (error: unknown) {
    if (run?.status === 'running') {
      try {
        await store.runs.finalizeRun(
          run.id,
          options.signal?.aborted === true ? 'cancelled' : 'failed',
        );
      } catch (finalizeError: unknown) {
        throw new AttestCliError(
          'run_failed',
          `Run ${run.id} failed and its durable status could not be finalized.`,
          { cause: new AggregateError([error, finalizeError]) },
        );
      }
    }
    throw error;
  } finally {
    await store.close();
  }
};

export { runConfiguration, type RunConfigurationOptions, type RunExecutionResult };
