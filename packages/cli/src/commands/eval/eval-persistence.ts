import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';

import { AGENT_PROTOCOL, EVAL_RUN_SCHEMA_ID } from '@attest/contracts';
import {
  diffRuns,
  toStoredCaseExecution,
  toStoredMetricEvaluation,
  type AttestStore,
  type EvalArtifactWriter,
  type EvalBaselineAdapter,
  type EvalJUnitPayload,
  type EvalPersistenceAdapter,
  type RunDiff,
} from '@attest/core';

import { AttestCliError } from '../../errors/index.js';
import { prepareEvalProjectFile } from './eval-project-path.js';
import type { ResolvedEvalCaseInput } from './eval-resolver.js';

/** Binds immutable eval records and raw runner evidence to the existing SQLite run-store schema. */
const createEvalPersistenceAdapter = (
  store: AttestStore,
): EvalPersistenceAdapter<ResolvedEvalCaseInput> => ({
  createRun: async (run) => {
    const created = await store.runs.createRun(
      {
        schemaId: EVAL_RUN_SCHEMA_ID,
        configHash: run.snapshot_hash,
        configJson: JSON.stringify(run),
        ...(run.git?.commit === undefined ? {} : { gitSha: run.git.commit }),
        ...(run.git?.branch === undefined ? {} : { gitBranch: run.git.branch }),
        labels: { kind: 'eval', snapshot_hash: run.snapshot_hash },
      },
      { id: run.run_id, createdAt: run.created_at },
    );
    if (created.id !== run.run_id || created.createdAt !== run.created_at) {
      throw new Error('The run store did not preserve the immutable eval identity.');
    }
  },
  recordCase: async (runId, record) => {
    if (record.kind === 'executed') {
      await store.runs.recordCase(
        runId,
        toStoredCaseExecution(record.execution),
        record.metrics.map(toStoredMetricEvaluation),
      );
      return;
    }
    const payload = record.resolved_case.payload;
    await store.runs.recordCase(
      runId,
      {
        attempts: [],
        caseId: payload.case_id,
        diagnostics: {},
        durationMs: record.normalized.duration_ms,
        errorCode: record.normalized.outcome === 'cancelled' ? 'cancelled' : 'invalid_envelope',
        errorMessage: record.error.message,
        expectedMetrics: payload.metrics.map(({ metric }) => metric.id),
        outcome: record.normalized.outcome === 'cancelled' ? 'cancelled' : 'invocation_error',
        request: {
          protocol: AGENT_PROTOCOL,
          run_id: runId,
          case_id: payload.case_id,
          input: payload.case.input,
          ...(payload.case.params === undefined ? {} : { params: payload.case.params }),
        },
        startedAt: record.normalized.started_at,
        suiteName: payload.test_id,
        warnings: [],
      },
      [],
    );
  },
  finalizeRun: async (runId, status, summary) => {
    const finalized = await store.runs.finalizeRun(runId, status);
    const stored = finalized.summary;
    if (
      stored === undefined ||
      stored.totalCases !== summary.total_cases ||
      stored.passedCases !== summary.passed_cases ||
      stored.failedCases !== summary.failed_cases ||
      stored.errorCases !== summary.error_cases ||
      stored.metricErrorCount !== summary.metric_error_count
    ) {
      throw new Error('The persisted run summary drifted from eval orchestration.');
    }
  },
});

/** Uses the existing run-store diff engine after the candidate run has been fully recorded. */
const createEvalBaselineAdapter = (store: AttestStore): EvalBaselineAdapter<RunDiff> => ({
  diffRuns: ({ baselineRunId, candidateRunId }) =>
    diffRuns(store.runs, baselineRunId, candidateRunId),
});

/** Verifies the engine-provided JUnit integrity metadata before publishing any bytes. */
const verifyJUnitPayload = (payload: EvalJUnitPayload): void => {
  const bytes = Buffer.byteLength(payload.contents, 'utf8');
  const hash = createHash('sha256').update(payload.contents, 'utf8').digest('hex');
  if (bytes !== payload.byte_length || hash !== payload.sha256) {
    throw new AttestCliError('output_write_failed', 'JUnit integrity metadata is invalid.');
  }
};

/** Publishes JUnit through a synced sibling temporary file and one atomic rename. */
const createEvalArtifactWriter = (projectRoot: string): EvalArtifactWriter => ({
  writeJUnitAtomically: async (path, payload) => {
    verifyJUnitPayload(payload);
    const outputPath = await prepareEvalProjectFile(projectRoot, path, {
      allowAbsolute: true,
      createDirectories: true,
      errorCode: 'output_write_failed',
      message: 'The JUnit output path is not a safe project file.',
    });
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
      throw new AttestCliError(
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
