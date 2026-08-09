import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  EVAL_RUN_SCHEMA_VERSION,
  evalFinalResultDataSchema,
  evalRunSchema,
  type EvalCancelRequest,
  type EvalCancelResult,
  type EvalEvent,
  type EvalRun,
  type EvalRunRequest,
} from '@attest/contracts';
import {
  createRunIdentity,
  executeResolvedEvalPlan,
  openReadonlyRunStore,
  StoreError,
} from '@attest/core';

import { AttestCliError, serializeCliError } from '../errors.js';
import { createEvalCaseRunner } from '../commands/eval/eval-agent-runner.js';
import {
  detachEvalRun,
  registerEvalRun,
  signalRegisteredEvalRun,
  unregisterEvalRun,
} from '../commands/eval/eval-cancellation.js';
import {
  openEvalProjectStore,
  prepareEvalProjectFile,
} from '../commands/eval/eval-project-path.js';
import { EvalEventQueue } from '../commands/eval/eval-event-source.js';
import {
  createEvalArtifactWriter,
  createEvalBaselineAdapter,
  createEvalPersistenceAdapter,
} from '../commands/eval/eval-persistence.js';
import { resolveEvalRun } from '../commands/eval/eval-resolver.js';
import { loadCommandProject } from '../commands/project/load-command-project.js';
import { createCliFailureResult, createCliSuccessResult } from '../output/cli-protocol.js';

const execFileAsync = promisify(execFile);

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
  const configuredStorePath = join('.attest', 'runs.db');
  const storePath = await prepareEvalProjectFile(project.root, configuredStorePath, {
    errorCode: 'run_failed',
    message: 'The eval run store is not a safe project file.',
  });
  await preflightEvalBaseline(storePath, resolved.effectiveCommand.resolved.baseline_run_id);
  const store = await openEvalProjectStore(project.root);
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
          artifacts: createEvalArtifactWriter(project.root),
          baseline: createEvalBaselineAdapter(store),
          onEvent: (event) => queue.push(event),
          signal: AbortSignal.any([options.signal, registry.signal]),
          terminalFailure: (code, message) => {
            const failure = serializeCliError(new AttestCliError(code, message));
            return evalFinalResultDataSchema.parse({
              exit_code: failure.exitCode,
              result: createCliFailureResult('eval.run', failure.error),
            });
          },
        },
      );
      canReleaseCancellationOwnership = result.can_release_cancellation_ownership;
    } catch (error: unknown) {
      queue.fail(error);
    } finally {
      // Preserve cancellation ownership when cleanup or durable finalization remains uncertain.
      if (canReleaseCancellationOwnership) {
        await unregisterEvalRun(registry).catch(() => undefined);
      } else {
        detachEvalRun(registry);
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
  type CancelConfigurationOptions,
  type RunConfigurationOptions,
};
