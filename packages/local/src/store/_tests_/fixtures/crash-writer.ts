import * as Effect from 'effect/Effect';
import { withStoreScope } from '../../internal/store-scope.js';
import { AGENT_PROTOCOL } from '@attest/contracts';

import { openStore } from '../../run-store.js';

const databasePath = process.argv[2];

if (!databasePath) {
  throw new Error('Expected the database path as argv[2].');
}

await Effect.runPromiseExit(
  withStoreScope((owner) =>
    Effect.gen(function* () {
      const store = (yield* openStore(databasePath, owner)).runs;

      const run = yield* store.createRun({
        schemaId: 'attest.project',
        configHash: 'crash',
        configJson: '{}',
      });

      yield* store.recordCase(
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
    }),
  ),
);
