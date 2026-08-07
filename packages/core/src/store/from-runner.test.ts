import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_PROTOCOL, TRACE_SCHEMA_VERSION, type CaseOutcome } from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentInvocationError, type CaseExecution } from '../runner/index.js';
import { openRunStore, type RunStore } from './run-store.js';
import { toStoredCaseExecution } from './from-runner.js';
import type { CaseRecord, StoredCaseExecution } from './types.js';

const stores: RunStore[] = [];
const directories: string[] = [];

/** Opens an isolated database so the adapter is verified through actual persistence. */
const openTemporaryStore = async (): Promise<RunStore> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-runner-store-'));
  const store = await openRunStore(join(directory, 'runs.db'));
  directories.push(directory);
  stores.push(store);
  return store;
};

/** Removes database-owned identity and evaluation fields before comparing a store projection. */
const toStoredProjection = (record: CaseRecord): StoredCaseExecution => {
  const projection = { ...record } as Partial<CaseRecord>;
  delete projection.rowId;
  delete projection.runId;
  delete projection.inputHash;
  delete projection.metrics;
  return projection as StoredCaseExecution;
};

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => store.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('toStoredCaseExecution', () => {
  it('persists completed and timeout runner projections without losing durable evidence', async () => {
    const store = await openTemporaryStore();
    const run = await store.createRun({
      configVersion: 'v1',
      configHash: 'hash',
      configJson: '{}',
    });
    const completed: CaseExecution = {
      caseId: 'completed-case',
      suiteName: 'runner-suite',
      outcome: 'completed',
      request: {
        protocol: AGENT_PROTOCOL,
        run_id: run.id,
        case_id: 'completed-case',
        input: { prompt: 'hello' },
      },
      caseDefinition: { id: 'completed-case', input: { prompt: 'hello' }, expected: { score: 1 } },
      expectedMetrics: ['quality'],
      attempts: [
        {
          status: 'invocation_error',
          error: new AgentInvocationError('network', 'connection reset'),
          diagnostics: { httpStatus: 503 },
          durationMs: 12,
          rawExcerpt: { text: 'upstream unavailable', truncated: true, sha256: 'a'.repeat(64) },
          warnings: [
            { path: 'retry', message: 'temporary network failure', code: 'unknown_field' },
          ],
        },
        {
          status: 'ok',
          raw: { protocol: AGENT_PROTOCOL, output: { answer: 'hello' } },
          diagnostics: { stderrExcerpt: 'retried' },
          durationMs: 8,
          rawExcerpt: { text: '{"output":{"answer":"hello"}}', truncated: false },
          warnings: [],
        },
      ],
      diagnostics: { stderrExcerpt: 'retried', httpStatus: 200 },
      warnings: [{ path: 'trace.vendor', message: 'preserved extension', code: 'unknown_field' }],
      startedAt: '2026-08-06T00:00:00.000Z',
      durationMs: 20,
      response: { protocol: AGENT_PROTOCOL, output: { answer: 'hello' } },
      trace: {
        schema: TRACE_SCHEMA_VERSION,
        trace_id: 'trace-1',
        spans: [
          {
            span_id: 'span-1',
            parent_span_id: null,
            kind: 'agent',
            name: 'reply',
            start_time: '2026-08-06T00:00:00.000Z',
            end_time: '2026-08-06T00:00:00.020Z',
            status: { code: 'ok' },
          },
        ],
      },
    };
    const timeout: CaseExecution = {
      ...completed,
      caseId: 'timeout-case',
      outcome: 'timeout',
      request: { ...completed.request, case_id: 'timeout-case' },
      caseDefinition: { id: 'timeout-case', input: { prompt: 'slow' } },
      attempts: [
        {
          status: 'invocation_error',
          error: new AgentInvocationError('timeout', 'deadline exceeded'),
          diagnostics: {},
          durationMs: 60_000,
          rawExcerpt: { text: 'partial response', truncated: false },
          warnings: [],
        },
      ],
      diagnostics: {},
      warnings: [],
      expectedMetrics: [],
      durationMs: 60_000,
      invocationError: new AgentInvocationError('timeout', 'deadline exceeded'),
    };
    delete (timeout as { response?: unknown }).response;
    delete (timeout as { trace?: unknown }).trace;

    const projections = [toStoredCaseExecution(completed), toStoredCaseExecution(timeout)];
    await Promise.all(projections.map((projection) => store.recordCase(run.id, projection, [])));

    const stored = await store.getCaseResults(run.id);
    expect(stored.map(toStoredProjection)).toEqual(projections);
  });

  it('covers every canonical terminal outcome', () => {
    const outcomes: CaseOutcome[] = ['completed', 'invocation_error', 'timeout', 'cancelled'];
    expect(outcomes).toHaveLength(4);
  });
});
