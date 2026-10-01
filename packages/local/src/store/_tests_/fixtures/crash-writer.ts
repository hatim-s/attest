import { AGENT_PROTOCOL } from '@attest/contracts';

import { openStore } from '../../run-store.js';

const databasePath = process.argv[2];
if (!databasePath) {
  throw new Error('Expected the database path as argv[2].');
}

const store = (await openStore(databasePath)).runs;
const run = await store.createRun({
  schemaId: 'attest.project',
  configHash: 'crash',
  configJson: '{}',
});
await store.recordCase(
  run.id,
  {
    caseId: 'crash-case',
    suiteName: 'suite',
    outcome: 'completed',
    startedAt: '2026-08-06T00:00:00.000Z',
    durationMs: 1,
    request: {
      protocol: AGENT_PROTOCOL,
      run_id: run.id,
      case_id: 'crash-case',
      input: {},
    },
    response: {},
    warnings: [],
    diagnostics: {},
    attempts: [],
    expectedMetrics: [],
  },
  [],
);
process.stdout.write(run.id);
process.exit(1);
