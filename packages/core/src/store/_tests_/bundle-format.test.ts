import { AGENT_PROTOCOL } from '@attest/contracts';
import { expect, it } from 'vitest';

import { createBundle, verifyBundleLines } from '../bundle-format.js';
import { StoreError } from '../store-error.js';
import type { CaseRecord, RunRecord } from '../types.js';

const run: RunRecord = {
  id: '01JA0000000000000000000000',
  status: 'completed',
  schemaId: 'attest.project',
  configHash: 'hash',
  configJson: '{}',
  createdAt: '2026-10-20T00:00:00.000Z',
  finishedAt: '2026-10-20T00:00:01.000Z',
};

const record: CaseRecord = {
  rowId: 'row',
  runId: run.id,
  caseId: 'case',
  suiteName: 'suite',
  inputHash: 'hash',
  outcome: 'completed',
  request: { protocol: AGENT_PROTOCOL, run_id: run.id, case_id: 'case', input: {} },
  response: {},
  startedAt: run.createdAt,
  durationMs: 1,
  warnings: [],
  diagnostics: {},
  attempts: [],
  expectedMetrics: [],
  metrics: [],
};

it('rejects the first duplicate case identity or row ID even when the bundle hash is valid', () => {
  for (const [duplicate, message] of [
    [{ ...record, rowId: 'other-row' }, 'Run bundle contains duplicate case ["suite","case"].'],
    [{ ...record, caseId: 'other-case' }, 'Run bundle contains duplicate rowId "row".'],
  ] as const) {
    const bundle = createBundle(run, [record, duplicate, record]);

    expect(() => verifyBundleLines(bundle.lines)).toThrowError(
      new StoreError('CORRUPT_DATA', message),
    );
  }
});
