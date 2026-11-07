import { valueFromExit } from '../../internal/effect-exit.js';
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
  createRun: async (run) => {
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

    valueFromExit(
      // EFFECT-BRIDGE(S7b)
      await Effect.runPromiseExit(
        store.runs.createRun(createdRun, { id: run.run_id, createdAt: run.created_at }),
      ),
    );
  },
  recordCase: async (runId, record) => {
    if (record.kind === 'executed') {
      valueFromExit(
        // EFFECT-BRIDGE(S7b)
        await Effect.runPromiseExit(
          store.runs.recordCase(runId, toStoredCaseExecution(record.execution), [
            ...record.metrics,
          ]),
        ),
      );

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

    // EFFECT-BRIDGE(S7b)
    valueFromExit(await Effect.runPromiseExit(store.runs.recordCase(runId, skippedExecution, [])));
  },
  finalizeRun: async (runId, status) => {
    // EFFECT-BRIDGE(S7b)
    valueFromExit(await Effect.runPromiseExit(store.runs.finalizeRun(runId, status)));
  },
});

/** Uses the existing run-store diff engine after the candidate run has been fully recorded. */
const createEvalBaselineAdapter = (store: AttestStore): EvalBaselineAdapter<RunDiff> => ({
  diffRuns: async ({ baselineRunId, candidateRunId }) => {
    return valueFromExit(
      // EFFECT-BRIDGE(S7b)
      await Effect.runPromiseExit(diffRuns(store.runs, baselineRunId, candidateRunId)),
    );
  },
});

/** Verifies the engine-provided JUnit integrity metadata before publishing any bytes. */
const verifyJUnitPayload = (payload: EvalJUnitPayload): void => {
  const bytes = Buffer.byteLength(payload.contents, 'utf8');
  const hash = createHash('sha256').update(payload.contents, 'utf8').digest('hex');

  if (bytes !== payload.byte_length || hash !== payload.sha256) {
    throw new LocalError('output_write_failed', 'JUnit integrity metadata is invalid.');
  }
};

/** Publishes JUnit through a synced sibling temporary file and one atomic rename. */
const createEvalArtifactWriter = (projectRoot: string): EvalArtifactWriter => ({
  writeJUnitAtomically: async (path, payload) => {
    verifyJUnitPayload(payload);

    // EFFECT-BRIDGE(S7b)
    const outputPath = await Effect.runPromiseExit(
      prepareEvalProjectFile(projectRoot, path, {
        allowAbsolute: true,
        createDirectories: true,
        errorCode: 'output_write_failed',
        message: 'The JUnit output path is not a safe project file.',
      }),
    ).then((exit) => valueFromExit(exit));

    const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      // Publish the exact byte sequence whose length and digest were verified above.
      await handle.writeFile(payload.contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, outputPath);
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw new LocalError(
        'output_write_failed',
        `Could not write JUnit output to ${outputPath}.`,
        {
          cause: error,
        },
      );
    }
  },
});

export { createEvalArtifactWriter, createEvalBaselineAdapter, createEvalPersistenceAdapter };
