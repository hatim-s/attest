import * as Effect from 'effect/Effect';
import { EVAL_RUN_SCHEMA_ID } from '@attest/contracts';
import { summarizeCaseRecord } from '@attest/core';
import type { CaseRecord, RunRecord } from '@attest/core/records';
import { describe, expect, it } from 'vitest';

import { createApiClient } from '../api-client.js';
import { valueFromExit } from './native-root.js';

// A trimmed copy of the public eval-run fixture; it plans two `refund` cases.
const configJson = JSON.stringify({
  schema: 'attest.eval-run',
  run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  created_at: '2026-08-08T10:00:00.000Z',
  snapshot_hash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  snapshot: {
    project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAB',
    project_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    resource_hashes: {
      agents: [
        {
          id: 'support',
          content_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ],
      tests: [
        {
          id: 'refund',
          content_hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        },
      ],
      datasets: [],
      metrics: [
        {
          id: 'correct',
          content_hash: 'abababababababababababababababababababababababababababababababab',
        },
      ],
    },
    selected_test_ids: ['refund'],
    selected_cases: [
      {
        configured_index: 0,
        test_id: 'refund',
        case_id: 'refund-basic',
        source: {
          kind: 'direct',
        },
      },
      {
        configured_index: 1,
        test_id: 'refund',
        case_id: 'refund-delayed',
        source: {
          kind: 'direct',
        },
      },
    ],
  },
  effective_command: {
    command_path: ['eval', 'run'],
    argv: ['eval', 'run', 'refund', '--output', 'jsonl'],
    request: {
      schema: 'attest.command-request',
      command: 'eval.run',
      test_ids: ['refund'],
      case_ids: ['refund-basic', 'refund-delayed'],
      concurrency: 2,
      timeout_ms: 60000,
      output: 'jsonl',
    },
    resolved: {
      concurrency: 2,
      timeout_ms: 60000,
      output: 'jsonl',
      watch: false,
    },
  },
  git: {
    commit: 'c25394a527624885e56d36ab2dbe1cd64458c2c5',
    branch: 'phase/eval-integration',
    dirty: false,
  },
});

const project = { key: 'demo', name: 'Demo' };

const projectKey = project.key;

const finished = (status: 'completed' | 'cancelled'): RunRecord => ({
  id: 'run-1',
  schemaId: EVAL_RUN_SCHEMA_ID,
  configHash: 'hash',
  configJson,
  createdAt: '2026-10-18T10:00:00.000Z',
  status,
  finishedAt: '2026-10-18T10:05:00.000Z',
});

const base = (caseId: string) => ({
  rowId: `row-${caseId}`,
  runId: 'run-1',
  suiteName: 'refund',
  caseId,
  inputHash: 'input',
  startedAt: '2026-10-18T10:00:00.000Z',
  durationMs: 10,
  request: {
    protocol: 'attest.agent-invocation' as const,
    run_id: 'run-1',
    case_id: caseId,
    input: {},
  },
  attempts: [],
  warnings: [],
  diagnostics: {},
  expectedMetrics: [],
  metrics: [],
});

const record = (caseId: string, outcome: 'completed' | 'cancelled'): CaseRecord =>
  outcome === 'completed'
    ? { ...base(caseId), outcome, response: { output: 'ok' } }
    : { ...base(caseId), outcome, errorCode: 'cancelled', errorMessage: 'Run cancelled.' };

const clientFor = (run: RunRecord, records: CaseRecord[], truncated = false) =>
  createApiClient({
    kind: 'snapshot',
    snapshot: {
      generatedAt: '2026-10-18T11:00:00.000Z',
      project,
      run,
      cases: records.map((item) => ({ record: item, summary: summarizeCaseRecord(item) })),
      truncated,
    },
  });

const read = <A, E extends Error>(effect: Effect.Effect<A, E>) =>
  Effect.runPromiseExit(effect).then(valueFromExit);

describe('snapshot dashboard reads', () => {
  it('answers every dashboard read for one complete run', async () => {
    const client = clientFor(finished('completed'), [
      record('refund-basic', 'completed'),
      record('refund-delayed', 'completed'),
    ]);

    const evals = await read(client.listEvals({ projectKey }, {}));
    expect(evals.items).toHaveLength(1);
    expect(evals.items[0]).toMatchObject({
      suiteName: 'refund',
      latestComplete: { state: 'complete', passRate: 1 },
      failing: false,
    });

    expect(await read(client.getProjectOverview({ projectKey }))).toMatchObject({
      runningRunCount: 0,
      lastRunAt: '2026-10-18T10:00:00.000Z',
    });
    expect(await read(client.listOverviews())).toMatchObject({
      items: [{ status: 'ready', project }],
    });

    const window = await read(
      client.getEvalCaseWindow({ projectKey, suiteName: 'refund' }, { limit: 1 }),
    );

    expect(window.runs.map((slice) => slice.runId)).toEqual(['run-1']);
    expect(window.items).toEqual([{ caseId: 'refund-basic', cells: ['pass'] }]);
    expect(window.nextCursor).toBe('refund-basic');

    expect(
      await read(
        client.getCaseHistory({ projectKey, suiteName: 'refund', caseId: 'refund-delayed' }, {}),
      ),
    ).toEqual({
      items: [
        {
          runId: 'run-1',
          createdAt: '2026-10-18T10:00:00.000Z',
          runStatus: 'completed',
          cell: 'pass',
          durationMs: 10,
        },
      ],
    });

    const activity = await read(
      client.getActivity(
        { projectKey },
        { from: '2026-10-05T00:00:00.000Z', to: '2026-10-19T00:00:00.000Z' },
      ),
    );

    expect(activity.days).toEqual([
      { day: '2026-10-18', slices: 1, passed: 2, failed: 0, errored: 0, skipped: 0 },
    ]);

    expect(
      await read(
        client.listEvalRuns(
          { projectKey, suiteName: 'refund' },
          {
            since: '2026-10-19T00:00:00.000Z',
          },
        ),
      ),
    ).toEqual({ items: [] });
  });

  it('never gives a pass rate to a cancelled, running or truncated slice', async () => {
    const cancelled = clientFor(finished('cancelled'), [
      record('refund-basic', 'completed'),
      record('refund-delayed', 'cancelled'),
    ]);

    const running = clientFor(
      { ...finished('completed'), status: 'running', finishedAt: undefined },
      [record('refund-basic', 'completed')],
    );

    const truncated = clientFor(
      finished('completed'),
      [record('refund-basic', 'completed'), record('refund-delayed', 'completed')],
      true,
    );

    const [cancelledSlice] = (await read(cancelled.listRunSuites({ projectKey, runId: 'run-1' })))
      .suites;

    expect(cancelledSlice).toMatchObject({
      state: 'incomplete',
      passRate: null,
      counts: { passed: 1, skipped: 1, notRun: 0 },
    });

    const [runningSlice] = (await read(running.listRunSuites({ projectKey, runId: 'run-1' })))
      .suites;

    expect(runningSlice).toMatchObject({ state: 'running', passRate: null });
    expect(await read(running.getProjectOverview({ projectKey }))).toMatchObject({
      runningRunCount: 1,
    });

    const [truncatedSlice] = (await read(truncated.listRunSuites({ projectKey, runId: 'run-1' })))
      .suites;

    expect(truncatedSlice).toMatchObject({
      state: 'incomplete',
      passRate: null,
      counts: { planned: null, notRun: null },
    });
  });

  it('rejects activity intervals the stores reject', async () => {
    const client = clientFor(finished('completed'), [record('refund-basic', 'completed')]);

    await expect(
      read(
        client.getActivity(
          { projectKey },
          { from: '2026-01-01T00:00:00.000Z', to: '2026-10-19T00:00:00.000Z' },
        ),
      ),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
  });
});
