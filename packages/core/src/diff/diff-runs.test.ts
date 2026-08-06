import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_PROTOCOL } from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { openRunStore } from '../store/run-store.js';
import type { RunRecord, RunStore } from '../store/types.js';
import { diffRuns } from './diff-runs.js';

const stores: RunStore[] = [];
const directories: string[] = [];

/** Opens an independent real SQLite store for cross-store diff integration coverage. */
const openTemporaryStore = async (): Promise<RunStore> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-diff-runs-'));
  directories.push(directory);
  const store = await openRunStore(join(directory, 'runs.db'));
  stores.push(store);
  return store;
};

/** Persists one completed comparable case with a controlled verdict and score. */
const createComparableRun = async (
  store: RunStore,
  configHash: string,
  pass: boolean,
): Promise<RunRecord> => {
  const run = await store.createRun({ configVersion: 'v1', configHash, configJson: '{}' });
  await store.recordCase(
    run.id,
    {
      caseId: 'case',
      suiteName: 'suite',
      outcome: 'completed',
      startedAt: '2026-08-06T00:00:00.000Z',
      durationMs: 1,
      request: {
        protocol: AGENT_PROTOCOL,
        run_id: run.id,
        case_id: 'case',
        input: { prompt: 'same input' },
      },
      response: {},
      warnings: [],
      diagnostics: {},
      attempts: [],
      expectedMetrics: ['quality'],
    },
    [{ metricName: 'quality', kind: 'assertion', status: 'evaluated', score: 0.5, pass }],
  );
  return store.finalizeRun(run.id, 'completed');
};

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => store.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('diffRuns', () => {
  it('uses persisted input hashes for live cross-store flakiness annotations', async () => {
    const baseStore = await openTemporaryStore();
    const candidateStore = await openTemporaryStore();
    const base = await createComparableRun(baseStore, 'same-config', true);
    const candidate = await createComparableRun(candidateStore, 'same-config', false);

    await expect(diffRuns(baseStore, base.id, candidate.id, candidateStore)).resolves.toMatchObject(
      {
        transitions: [{ kind: 'regressed', flakiness: 'suspected' }],
      },
    );

    const changedConfig = await createComparableRun(candidateStore, 'different-config', false);
    const changedConfigDiff = await diffRuns(baseStore, base.id, changedConfig.id, candidateStore);
    expect(changedConfigDiff.transitions[0]).toMatchObject({
      kind: 'regressed',
      flakiness: undefined,
    });
  });
});
