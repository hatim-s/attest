import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  EVAL_RUN_SCHEMA_VERSION,
  evalRunSchema,
  type EvalCancelRequest,
  type EvalCancelResult,
  type EvalEvent,
  type EvalRun,
  type EvalRunRequest,
  type MetricDefinition,
} from '@attest/contracts';
import {
  caseExecutionToMetricContext,
  createRunIdentity,
  createTanstackJudgeClient,
  diffRuns,
  evaluateMetrics,
  executeResolvedEvalPlan,
  executeCases,
  openReadonlyRunStore,
  openStore,
  StoreError,
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
import { createEvalCaseRunner } from '../commands/eval/eval-agent-runner.js';
import {
  registerEvalRun,
  signalRegisteredEvalRun,
  unregisterEvalRun,
} from '../commands/eval/eval-cancellation.js';
import { EvalEventQueue } from '../commands/eval/eval-event-source.js';
import {
  createEvalArtifactWriter,
  createEvalBaselineAdapter,
  createEvalPersistenceAdapter,
} from '../commands/eval/eval-persistence.js';
import { resolveEvalRun } from '../commands/eval/eval-resolver.js';
import { loadCommandProject } from '../commands/project/load-command-project.js';
import { createCliSuccessResult } from '../output/cli-protocol.js';

const execFileAsync = promisify(execFile);

type LegacyRunConfigurationOptions = {
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

type LegacyRunExecutionResult = {
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
const runLegacyConfiguration = async (
  loadedConfig: LoadedConfig,
  options: LegacyRunConfigurationOptions = {},
): Promise<LegacyRunExecutionResult> => {
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

type RunConfigurationOptions = {
  argv: readonly string[];
  project?: string;
  signal: AbortSignal;
  workingDirectory: string;
};

type CancelConfigurationOptions = {
  project?: string;
  workingDirectory: string;
};

/** Captures bounded Git metadata when the project is in a repository, otherwise omitting it. */
const readGitMetadata = async (projectRoot: string): Promise<EvalRun['git'] | undefined> => {
  const runGit = async (arguments_: string[]): Promise<string | undefined> => {
    try {
      const { stdout } = await execFileAsync('git', ['-C', projectRoot, ...arguments_], {
        encoding: 'utf8',
        timeout: 2_000,
      });
      const value = stdout.trim();
      return value.length === 0 ? undefined : value;
    } catch {
      return undefined;
    }
  };
  const commit = await runGit(['rev-parse', '--verify', 'HEAD']);
  if (commit === undefined || !/^[a-f0-9]{7,64}$/u.test(commit)) return undefined;
  const [branch, status] = await Promise.all([
    runGit(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    runGit(['status', '--porcelain=v1', '--untracked-files=normal']),
  ]);
  return {
    commit,
    ...(branch === undefined ? {} : { branch }),
    dirty: status !== undefined && status.length > 0,
  };
};

/** Confirms a requested baseline from a read-only store before any candidate side effects occur. */
const preflightEvalBaseline = async (storePath: string, baselineRunId?: string): Promise<void> => {
  if (baselineRunId === undefined) return;
  try {
    await access(storePath);
  } catch (error: unknown) {
    throw new AttestCliError('resource_not_found', `Eval run ${baselineRunId} was not found.`, {
      path: baselineRunId,
      cause: error,
    });
  }

  let store: Awaited<ReturnType<typeof openReadonlyRunStore>> | undefined;
  try {
    store = await openReadonlyRunStore(storePath);
    await store.getRun(baselineRunId);
  } catch (error: unknown) {
    if (error instanceof StoreError && error.code === 'RUN_NOT_FOUND') {
      throw new AttestCliError('resource_not_found', `Eval run ${baselineRunId} was not found.`, {
        path: baselineRunId,
        cause: error,
      });
    }
    throw error;
  } finally {
    await store?.close().catch(() => undefined);
  }
};

/** Runs one immutable v2 snapshot through resolver, engine, adapters, store, artifacts, and events. */
const runConfiguration = async (
  request: EvalRunRequest,
  options: RunConfigurationOptions,
): Promise<AsyncIterable<EvalEvent>> => {
  const project = await loadCommandProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });
  const resolved = resolveEvalRun(project, request, { argv: options.argv });
  const identity = createRunIdentity();
  const git = await readGitMetadata(project.root);
  const run = evalRunSchema.parse({
    schema: EVAL_RUN_SCHEMA_VERSION,
    run_id: identity.id,
    created_at: identity.createdAt,
    snapshot_hash: resolved.snapshotHash,
    snapshot: resolved.snapshot,
    effective_command: resolved.effectiveCommand,
    ...(git === undefined ? {} : { git }),
  });
  const storePath = join(project.root, '.attest', 'runs.db');
  await preflightEvalBaseline(storePath, resolved.effectiveCommand.resolved.baseline_run_id);
  await mkdir(join(project.root, '.attest'), { recursive: true });
  const store = await openStore(storePath);
  let registry: Awaited<ReturnType<typeof registerEvalRun>>;
  try {
    registry = await registerEvalRun(project.root, run.run_id);
  } catch (error: unknown) {
    await store.close();
    throw error;
  }

  const queue = new EvalEventQueue();
  const plan = {
    run,
    cases: resolved.cases.map((payload) => ({
      configured_index: payload.configured_index,
      test_id: payload.test_id,
      case_id: payload.case_id,
      source: payload.source,
      test_concurrency: payload.concurrency,
      payload,
    })),
  };
  const runner = createEvalCaseRunner(project.root, store.cache);
  void (async () => {
    let canReleaseCancellationOwnership = false;
    try {
      const result = await executeResolvedEvalPlan(
        plan,
        runner,
        createEvalPersistenceAdapter(store),
        {
          artifacts: createEvalArtifactWriter(options.workingDirectory),
          baseline: createEvalBaselineAdapter(store),
          onEvent: (event) => queue.push(event),
          signal: options.signal,
        },
      );
      canReleaseCancellationOwnership = result.can_release_cancellation_ownership;
    } catch (error: unknown) {
      queue.fail(error);
    } finally {
      // Preserve cancellation ownership when cleanup or durable finalization remains uncertain.
      if (canReleaseCancellationOwnership) {
        await unregisterEvalRun(registry).catch(() => undefined);
      }
      await store.close().catch(() => undefined);
      queue.close();
    }
  })();
  return queue;
};

/** Requests cancellation through the active registry, then reports persisted terminal state. */
const cancelConfiguration = async (
  request: EvalCancelRequest,
  options: CancelConfigurationOptions,
): Promise<EvalCancelResult> => {
  const project = await loadCommandProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });
  const requested = await signalRegisteredEvalRun(project.root, request.run_id);
  let status: 'cancellation_requested' | 'already_cancelled' | 'already_terminal';
  if (requested === 'cancellation_requested') status = requested;
  else {
    const storePath = join(project.root, '.attest', 'runs.db');
    let store: Awaited<ReturnType<typeof openReadonlyRunStore>> | undefined;
    try {
      store = await openReadonlyRunStore(storePath);
      const run = await store.getRun(request.run_id);
      status = run.status === 'cancelled' ? 'already_cancelled' : 'already_terminal';
    } catch (error: unknown) {
      throw new AttestCliError('resource_not_found', `Eval run ${request.run_id} was not found.`, {
        path: request.run_id,
        cause: error,
      });
    } finally {
      await store?.close().catch(() => undefined);
    }
  }
  return createCliSuccessResult(
    'eval.cancel',
    { run_id: request.run_id, status },
    { projectHashBefore: project.projectHash, projectHashAfter: project.projectHash },
  ) as EvalCancelResult;
};

export {
  cancelConfiguration,
  runConfiguration,
  runLegacyConfiguration,
  type CancelConfigurationOptions,
  type LegacyRunConfigurationOptions,
  type LegacyRunExecutionResult,
  type RunConfigurationOptions,
};
