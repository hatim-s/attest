import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import { StoreCleanup } from '../store/internal/store-effect.js';
import { valueFromExit } from '../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  parseWithSchemaSync,
  EVAL_RUN_SCHEMA_ID,
  evalRunSchema,
  type EvalCancelRequest,
  type EvalEvent,
  type EvalRun,
  type EvalRunRequest,
} from '@attest/contracts';
import { StoreError, type RunRecord } from '@attest/core';
import { executeResolvedEvalPlan, type EvalTerminalFailureFactory } from '@attest/runtime';

import { withReadonlyRunStoreFile } from '../commands/run-store/readonly-run-store.js';
import * as Exit from 'effect/Exit';
import { startPromiseStoreOwner } from '../internal/promise-store-owner.js';
import { LocalError } from '../errors/index.js';
import { createRunIdentity } from '../store/run-store.js';
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
import { metricSandboxIsolation } from '../commands/eval/metric-sandbox.js';
import { loadCommandProject } from '../commands/project/load-command-project.js';
import { withRunNotFound } from '../commands/run-store/run-not-found.js';

const execFileAsync = promisify(execFile);

type RunConfigurationOptions = {
  argv: readonly string[];
  project?: string;
  signal: AbortSignal;
  terminalFailure: EvalTerminalFailureFactory;
  workingDirectory: string;
};

type CancelConfigurationOptions = {
  project?: string;
  workingDirectory: string;
};

type CancelConfigurationResult = {
  projectHash: string;
  runId: string;
  status: 'cancellation_requested' | 'already_cancelled' | 'already_terminal';
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

  {
    let assembledFields: EvalRun['git'] | undefined = {
      commit,
      dirty: status !== undefined && status.length > 0,
    };

    if (branch !== undefined) {
      assembledFields = { ...assembledFields, branch: branch };
    }

    return assembledFields;
  }
};

/** Reads one run from a read-only store; a missing store or run is `resource_not_found`. */
const readStoredRun = async (storePath: string, runId: string): Promise<RunRecord> => {
  const runNotFound = (cause?: unknown): LocalError =>
    new LocalError('resource_not_found', `Eval run ${runId} was not found.`, {
      path: runId,
      cause,
    });

  const run = valueFromExit(
    // EFFECT-BRIDGE(S7b)
    await Effect.runPromiseExit(
      withReadonlyRunStoreFile(storePath, (store) =>
        withRunNotFound(() => store.getRun(runId), runNotFound),
      ),
    ),
  );

  if (run === undefined) throw runNotFound();

  return run;
};

/** Runs one immutable snapshot through resolver, engine, adapters, store, artifacts, and events. */
const runConfiguration = async (
  request: EvalRunRequest,
  options: RunConfigurationOptions,
): Promise<AsyncIterable<EvalEvent>> => {
  // EFFECT-BRIDGE(S7b)
  const project = await Effect.runPromiseExit(
    loadCommandProject({
      project: options.project,
      workingDirectory: options.workingDirectory,
    }),
  ).then((exit) => valueFromExit(exit));

  const resolved = resolveEvalRun(project, request, { argv: options.argv });
  const identity = createRunIdentity();
  const git = await readGitMetadata(project.root);

  let runCandidate: typeof evalRunSchema.Encoded = {
    schema: EVAL_RUN_SCHEMA_ID,
    run_id: identity.id,
    created_at: identity.createdAt,
    snapshot_hash: resolved.snapshotHash,
    snapshot: resolved.snapshot,
    effective_command: resolved.effectiveCommand,
  };

  if (git !== undefined) runCandidate = { ...runCandidate, git: git };
  const run = parseWithSchemaSync(evalRunSchema, runCandidate);

  const configuredStorePath = join('.attest', 'runs.db');

  // EFFECT-BRIDGE(S7b)
  const storePath = await Effect.runPromiseExit(
    prepareEvalProjectFile(project.root, configuredStorePath, {
      errorCode: 'run_failed',
      message: 'The eval run store is not a safe project file.',
    }),
  ).then((exit) => valueFromExit(exit));

  // Confirm the baseline exists before any candidate side effect.
  const baselineRunId = resolved.effectiveCommand.resolved.baseline_run_id;

  if (baselineRunId !== undefined) await readStoredRun(storePath, baselineRunId);

  const lifetime = await startPromiseStoreOwner((owner) =>
    openEvalProjectStore(project.root, owner),
  );

  const store = lifetime.value;
  let registry: Awaited<ReturnType<typeof registerEvalRun>>;

  try {
    registry = await registerEvalRun(project.root, run.run_id);
  } catch (error: unknown) {
    await lifetime.finish(error instanceof Error ? Exit.fail(error) : Exit.die(error));
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

  const metricSandbox = run.effective_command.resolved.execution?.metric_sandbox;
  void (async () => {
    let canReleaseCancellationOwnership = false;
    let terminal: Exit.Exit<void, Error> = Exit.void;

    try {
      const runner = createEvalCaseRunner(project.root, store.cache, run);

      const result = await executeResolvedEvalPlan(
        plan,
        runner,
        createEvalPersistenceAdapter(store),
        {
          artifacts: createEvalArtifactWriter(project.root),
          baseline: createEvalBaselineAdapter(store),
          isolation:
            metricSandbox === undefined
              ? undefined
              : metricSandboxIsolation(project.root, resolved.cases, {
                  image: metricSandbox.image,
                }),
          onEvent: (event) => queue.push(event),
          signal: AbortSignal.any([options.signal, registry.signal]),
          terminalFailure: options.terminalFailure,
        },
      );

      canReleaseCancellationOwnership = result.can_release_cancellation_ownership;
    } catch (error: unknown) {
      terminal = error instanceof Error ? Exit.fail(error) : Exit.die(error);
    } finally {
      try {
        try {
          // Registry reconciliation precedes database closure even when it fails.
          if (canReleaseCancellationOwnership) await unregisterEvalRun(registry);
          else detachEvalRun(registry);
        } catch (error: unknown) {
          if (Exit.isSuccess(terminal))
            terminal = error instanceof Error ? Exit.fail(error) : Exit.die(error);
          else {
            // Keep both failures in the native Cause before the store's finalizers run.
            const cleanup = Cause.fail(
              new StoreError('WRITE_FAILED', 'Cancellation registry release failed.', {
                cause: error,
              }),
            );

            const previous = Context.getOrUndefined(
              Cause.annotations(terminal.cause),
              StoreCleanup,
            );

            terminal = Exit.failCause(
              Cause.annotate(
                terminal.cause,
                Context.make(
                  StoreCleanup,
                  previous === undefined ? cleanup : Cause.combine(previous, cleanup),
                ),
                { overwrite: true },
              ),
            );
          }
        }

        await lifetime.finish(terminal);
      } catch (cause: unknown) {
        queue.fail(
          cause instanceof StoreError
            ? new LocalError('run_failed', 'The eval store boundary changed during opening.', {
                path: '.attest/runs.db',
                cause,
              })
            : cause,
        );
      }

      queue.close();
    }
  })();

  return queue;
};

/** Requests cancellation through the active registry, then reports persisted terminal state. */
const cancelConfiguration = async (
  request: EvalCancelRequest,
  options: CancelConfigurationOptions,
): Promise<CancelConfigurationResult> => {
  // EFFECT-BRIDGE(S7b)
  const project = await Effect.runPromiseExit(
    loadCommandProject({
      project: options.project,
      workingDirectory: options.workingDirectory,
    }),
  ).then((exit) => valueFromExit(exit));

  const result = { projectHash: project.projectHash, runId: request.run_id };
  const requested = await signalRegisteredEvalRun(project.root, request.run_id);

  if (requested === 'cancellation_requested') return { ...result, status: requested };
  const run = await readStoredRun(join(project.root, '.attest', 'runs.db'), request.run_id);

  return {
    ...result,
    status: run.status === 'cancelled' ? 'already_cancelled' : 'already_terminal',
  };
};

export {
  cancelConfiguration,
  runConfiguration,
  type CancelConfigurationOptions,
  type RunConfigurationOptions,
};
