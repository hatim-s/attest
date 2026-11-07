import * as Deferred from 'effect/Deferred';
import { CancellationRegistry } from '../commands/eval/eval-cancellation.js';
import { finishWithRelease } from '../commands/agent/adapter/lifecycle-cause.js';
import * as Cause from 'effect/Cause';
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
import { executeResolvedEvalPlan, type EvalTerminalFailureFactory } from '@attest/runtime';

import { withReadonlyRunStoreFile } from '../commands/run-store/readonly-run-store.js';
import * as Exit from 'effect/Exit';
import { EvalApplication, applicationStore } from '../commands/eval/eval-application.js';
import { LocalError } from '../errors/index.js';
import { createRunIdentity } from '../store/run-store.js';
import { createEvalCaseRunner } from '../commands/eval/eval-agent-runner.js';
import {
  detachEvalRun,
  registerEvalRun,
  signalRegisteredEvalRun,
  unregisterEvalRun,
} from '../commands/eval/eval-cancellation.js';
import { prepareEvalProjectFile } from '../commands/eval/eval-project-path.js';
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
const readGitMetadata = Effect.fn('readGitMetadata')(function* (projectRoot: string) {
  const runGit = (arguments_: string[]) =>
    Effect.tryPromise({
      try: () =>
        execFileAsync('git', ['-C', projectRoot, ...arguments_], {
          encoding: 'utf8',
          timeout: 2_000,
        }),
      catch: (cause) => new Error('Git metadata unavailable.', { cause }),
    }).pipe(
      Effect.map(({ stdout }) => stdout.trim() || undefined),
      Effect.orElseSucceed(() => undefined),
    );

  const commit = yield* runGit(['rev-parse', '--verify', 'HEAD']);

  if (commit === undefined || !/^[a-f0-9]{7,64}$/u.test(commit)) return undefined;

  const [branch, status] = yield* Effect.all(
    [
      runGit(['symbolic-ref', '--quiet', '--short', 'HEAD']),
      runGit(['status', '--porcelain=v1', '--untracked-files=normal']),
    ],
    { concurrency: 2 },
  );

  let metadata: NonNullable<EvalRun['git']> = {
    commit,
    dirty: status !== undefined && status.length > 0,
  };

  if (branch !== undefined) metadata = { ...metadata, branch };

  return metadata;
});

/** Reads one run from a read-only store; a missing store or run is `resource_not_found`. */
const readStoredRun = Effect.fn('readStoredRun')(function* (storePath: string, runId: string) {
  const runNotFound = (cause?: unknown): LocalError =>
    new LocalError('resource_not_found', `Eval run ${runId} was not found.`, {
      path: runId,
      cause,
    });

  const run = yield* withReadonlyRunStoreFile(storePath, (store) =>
    withRunNotFound(() => store.getRun(runId), runNotFound),
  );

  if (run === undefined) return yield* Effect.fail(runNotFound());

  return run;
});

/** Runs one immutable snapshot through resolver, engine, adapters, store, artifacts, and events. */
const runConfiguration = Effect.fn('runConfiguration')(function* (
  request: EvalRunRequest,
  options: RunConfigurationOptions,
): Effect.fn.Return<AsyncIterable<EvalEvent>, Error, EvalApplication | CancellationRegistry> {
  const project = yield* loadCommandProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });

  const resolved = resolveEvalRun(project, request, { argv: options.argv });
  const identity = createRunIdentity();
  const git = yield* readGitMetadata(project.root);

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

  const storePath = yield* prepareEvalProjectFile(project.root, configuredStorePath, {
    errorCode: 'run_failed',
    message: 'The eval run store is not a safe project file.',
  });

  // Confirm the baseline exists before any candidate side effect.
  const baselineRunId = resolved.effectiveCommand.resolved.baseline_run_id;

  if (baselineRunId !== undefined) yield* readStoredRun(storePath, baselineRunId);

  const application = yield* EvalApplication;
  const store = yield* applicationStore(project.root);
  const ready = yield* Deferred.make<void, Error>();
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
  const controller = new AbortController();

  const task = Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* registerEvalRun(project.root, run.run_id);
      yield* Deferred.succeed(ready, undefined);

      const primary = yield* Effect.exit(
        Effect.gen(function* () {
          const runner = yield* createEvalCaseRunner(project.root, store.cache, run);

          return yield* executeResolvedEvalPlan(plan, runner, createEvalPersistenceAdapter(store), {
            artifacts: createEvalArtifactWriter(project.root),
            baseline: createEvalBaselineAdapter(store),
            isolation:
              metricSandbox === undefined
                ? undefined
                : metricSandboxIsolation(project.root, resolved.cases, {
                    image: metricSandbox.image,
                  }),
            onEvent: (event) => queue.offer(event),
            signal: AbortSignal.any([options.signal, registry.signal, controller.signal]),
            terminalFailure: options.terminalFailure,
          });
        }),
      );

      const release = yield* Effect.exit(
        Exit.isSuccess(primary) && primary.value.can_release_cancellation_ownership
          ? unregisterEvalRun(registry)
          : detachEvalRun(registry),
      );

      return yield* finishWithRelease(primary, [release]);
    }),
  ).pipe(Effect.asVoid);

  // Scope closure waits for this evidence owner; business cancellation is supplied by signal.
  const fiber = yield* Effect.forkIn(
    Effect.uninterruptible(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(task);

        if (Exit.isFailure(exit)) {
          yield* Deferred.failCause(ready, exit.cause);
          queue.fail(Cause.squash(exit.cause));
        }

        queue.close();

        return yield* exit;
      }),
    ),
    application.scope,
  );

  application.runs.push({ fiber, controller });
  yield* Deferred.await(ready);

  return queue;
});

/** Requests cancellation through the active registry, then reports persisted terminal state. */
const cancelConfiguration = Effect.fn('cancelConfiguration')(function* (
  request: EvalCancelRequest,
  options: CancelConfigurationOptions,
): Effect.fn.Return<CancelConfigurationResult, Error, CancellationRegistry> {
  const project = yield* loadCommandProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });

  const result = { projectHash: project.projectHash, runId: request.run_id };
  const requested = yield* signalRegisteredEvalRun(project.root, request.run_id);

  if (requested === 'cancellation_requested') return { ...result, status: requested };
  const run = yield* readStoredRun(join(project.root, '.attest', 'runs.db'), request.run_id);

  return {
    ...result,
    status: run.status === 'cancelled' ? 'already_cancelled' : 'already_terminal',
  };
});

export {
  cancelConfiguration,
  runConfiguration,
  type CancelConfigurationOptions,
  type RunConfigurationOptions,
};
