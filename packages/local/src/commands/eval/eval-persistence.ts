import { finishWithRelease } from '../agent/adapter/lifecycle-cause.js';
import * as Effect from 'effect/Effect';
import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';

import { AGENT_PROTOCOL, EVAL_RUN_SCHEMA_ID, type AgentRequest } from '@attest/contracts';
import { diffRuns, type AttestStore, type RunDiff, type StoredCaseExecution } from '@attest/core';
import {
  toStoredCaseExecution,
  type EvalArtifactWriter,
  type EvalBaselineAdapter,
  type EvalJUnitPayload,
  type EvalPersistenceAdapter,
} from '@attest/runtime';

import { LocalError } from '../../errors/index.js';
import { prepareEvalProjectFile } from './eval-project-path.js';
import type { ResolvedEvalCaseInput } from './eval-resolver.js';

/** Binds immutable eval records and raw runner evidence to the existing SQLite run-store schema. */
const createEvalPersistenceAdapter = (
  store: AttestStore,
): EvalPersistenceAdapter<ResolvedEvalCaseInput> => ({
  createRun: (run) =>
    Effect.gen(function* () {
      let labels: NonNullable<Parameters<AttestStore['runs']['createRun']>[0]['labels']> = {
        kind: 'eval',
        snapshot_hash: run.snapshot_hash,
      };

      if (run.snapshot.selection !== undefined) {
        labels = { ...labels, selection_total: String(run.snapshot.selection.total_cases) };
        labels = { ...labels, selection_selected: String(run.snapshot.selection.selected_cases) };
      }

      let createdRun: Parameters<AttestStore['runs']['createRun']>[0] = {
        schemaId: EVAL_RUN_SCHEMA_ID,
        configHash: run.snapshot_hash,
        configJson: JSON.stringify(run),
        labels,
      };

      if (run.git?.commit !== undefined) {
        createdRun = { ...createdRun, gitSha: run.git.commit };
      }

      if (run.git?.branch !== undefined) {
        createdRun = { ...createdRun, gitBranch: run.git.branch };
      }

      yield* store.runs.createRun(createdRun, { id: run.run_id, createdAt: run.created_at });
    }),
  recordCase: (runId, record) =>
    Effect.gen(function* () {
      if (record.kind === 'executed') {
        yield* store.runs.recordCase(runId, toStoredCaseExecution(record.execution), [
          ...record.metrics,
        ]);

        return;
      }

      const payload = record.resolved_case.payload;

      let request: AgentRequest = {
        protocol: AGENT_PROTOCOL,
        run_id: runId,
        case_id: payload.case_id,
        input: payload.case.input,
      };

      if (payload.case.params !== undefined) {
        request = { ...request, params: payload.case.params };
      }

      const skippedExecution: StoredCaseExecution = {
        attempts: [],
        caseId: payload.case_id,
        diagnostics: {},
        durationMs: record.normalized.duration_ms,
        errorCode: record.normalized.outcome === 'cancelled' ? 'cancelled' : 'invalid_envelope',
        errorMessage: record.error.message,
        expectedMetrics: payload.metrics.map(({ metric }) => metric.id),
        outcome: record.normalized.outcome === 'cancelled' ? 'cancelled' : 'invocation_error',
        request,
        startedAt: record.normalized.started_at,
        suiteName: payload.test_id,
        warnings: [],
      };

      yield* store.runs.recordCase(runId, skippedExecution, []);
    }),
  finalizeRun: (runId, status) =>
    Effect.gen(function* () {
      yield* store.runs.finalizeRun(runId, status);
    }),
});

/** Uses the existing run-store diff engine after the candidate run has been fully recorded. */
const createEvalBaselineAdapter = (store: AttestStore): EvalBaselineAdapter<RunDiff> => ({
  diffRuns: ({ baselineRunId, candidateRunId }) =>
    Effect.gen(function* () {
      return yield* diffRuns(store.runs, baselineRunId, candidateRunId);
    }),
});

/** Verifies the engine-provided JUnit integrity metadata before publishing any bytes. */
const verifyJUnitPayload = Effect.fn('verifyJUnitPayload')(function* (payload: EvalJUnitPayload) {
  const { bytes, hash } = yield* Effect.try({
    try: () => ({
      bytes: Buffer.byteLength(payload.contents, 'utf8'),
      hash: createHash('sha256').update(payload.contents, 'utf8').digest('hex'),
    }),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error('Invalid JUnit payload.', { cause }),
  });

  if (bytes !== payload.byte_length || hash !== payload.sha256) {
    return yield* new LocalError('output_write_failed', 'JUnit integrity metadata is invalid.');
  }
});

/** Publishes JUnit through a synced sibling temporary file and one atomic rename. */
const createEvalArtifactWriter = (projectRoot: string): EvalArtifactWriter => ({
  writeJUnitAtomically: (path, payload) =>
    Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        yield* verifyJUnitPayload(payload);

        const outputPath = yield* prepareEvalProjectFile(projectRoot, path, {
          allowAbsolute: true,
          createDirectories: true,
          errorCode: 'output_write_failed',
          message: 'The JUnit output path is not a safe project file.',
        });

        const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;

        const io = <A>(operation: () => Promise<A>) =>
          Effect.tryPromise({
            try: operation,
            catch: (cause) =>
              new LocalError(
                'output_write_failed',
                `Could not write JUnit output to ${outputPath}.`,
                { cause },
              ),
          });

        // The stage is owned before open; acquisition remains masked through handle installation.
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        let published = false;

        const primary = yield* Effect.exit(
          Effect.gen(function* () {
            handle = yield* io(() => open(temporaryPath, 'wx', 0o600));
            const opened = handle;
            yield* io(() => opened.writeFile(payload.contents, 'utf8'));
            yield* io(() => opened.sync());
            yield* io(() => opened.close());
            handle = undefined;
            yield* io(() => rename(temporaryPath, outputPath));
            published = true;
          }),
        );

        const closed = yield* Effect.exit(
          handle === undefined ? Effect.void : io(() => handle!.close()),
        );

        const removed = yield* Effect.exit(
          published
            ? Effect.void
            : io(() => unlink(temporaryPath)).pipe(
                Effect.catchIf(
                  (error) => {
                    const cause = error.cause;

                    return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
                  },
                  () => Effect.void,
                ),
              ),
        );

        return yield* finishWithRelease(primary, [closed, removed]);
      }),
    ),
});

export { createEvalArtifactWriter, createEvalBaselineAdapter, createEvalPersistenceAdapter };
