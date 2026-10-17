import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_PROTOCOL } from '@attest/contracts';
import { Kysely } from 'kysely';
import { expect, it } from 'vitest';

import { readBoundedRunDetails } from '../bounded-run-details.js';
import { createSqliteDialect } from '../internal/kysely-sqlite-dialect.js';
import { openSqliteHandle } from '../internal/open-sqlite-handle.js';
import { openStore } from '../run-store.js';
import type { Database } from '../schema.js';

it('counts omitted cases without hydrating their corrupt detail blobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-bounded-details-'));
  const path = join(root, 'runs.db');
  const store = await openStore(path);

  const database = new Kysely<Database>({
    dialect: createSqliteDialect(await openSqliteHandle(path)),
  });

  try {
    const run = await store.runs.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });

    for (const caseId of ['first', 'second']) {
      await store.runs.recordCase(
        run.id,
        {
          caseId,
          suiteName: 'report',
          outcome: 'completed',
          startedAt: '2026-10-17T00:00:00.000Z',
          durationMs: 1,
          request: { protocol: AGENT_PROTOCOL, run_id: run.id, case_id: caseId, input: 'input' },
          response: { protocol: AGENT_PROTOCOL, output: 'output' },
          warnings: [],
          diagnostics: {},
          attempts: [],
          expectedMetrics: [],
        },
        [],
      );
    }

    const first = (await store.runs.listCaseSummaries(run.id, { limit: 1 })).items[0]!;
    await database
      .updateTable('cases')
      .set({ request_json: 'not JSON' })
      .where('run_id', '=', run.id)
      .where('case_id', '!=', first.caseId)
      .execute();
    const details = await readBoundedRunDetails(store.runs, { runId: run.id, limit: 1 });
    expect(details.totalCaseCount).toBe(2);
    expect(details.cases.map((record) => record.caseId)).toEqual([first.caseId]);
    await expect(store.runs.getRunWithCases(run.id)).rejects.toMatchObject({
      code: 'CORRUPT_DATA',
    });
  } finally {
    await database.destroy();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
