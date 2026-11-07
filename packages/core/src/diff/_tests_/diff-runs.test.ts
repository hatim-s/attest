import * as Effect from 'effect/Effect';
import { EVAL_RUN_SCHEMA_ID } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { StoreError } from '../../store/store-error.js';
import type { RunRecord, RunSource } from '../../store/types.js';
import { diffRuns } from '../diff-runs.js';

const runRecord = (id: string, schemaId: string, configJson: string): RunRecord => ({
  id,
  schemaId,
  configHash: 'config',
  configJson,
  createdAt: '2026-08-06T00:00:00.000Z',
  finishedAt: '2026-08-06T00:00:01.000Z',
  status: 'completed',
});

const storeWith = (runs: RunRecord[]): Pick<RunSource, 'getRunWithCases'> => ({
  getRunWithCases: (runId) => {
    const run = runs.find((candidate) => candidate.id === runId);

    if (run === undefined) {
      return Effect.fail(new StoreError('RUN_NOT_FOUND', `Run ${runId} not found.`));
    }

    return Effect.succeed({ run, cases: [] });
  },
});

describe('diffRuns', () => {
  const unreadableConfigs = [
    ['malformed JSON', '{'],
    ['JSON that fails evalRunSchema', '{}'],
  ] as const;

  const positions = ['base', 'candidate'] as const;

  it.each(
    unreadableConfigs.flatMap(([label, configJson]) =>
      positions.map((position) => ({ label, configJson, position })),
    ),
  )(
    'rejects a $position eval run whose config is $label as CORRUPT_DATA',
    async ({ configJson, position }) => {
      const corrupt = runRecord(position, EVAL_RUN_SCHEMA_ID, configJson);
      const otherId = position === 'base' ? 'candidate' : 'base';
      const other = runRecord(otherId, 'attest.other-run', '{}');
      const store = storeWith([corrupt, other]);

      await expect(run(diffRuns(store, 'base', 'candidate'))).rejects.toMatchObject({
        code: 'CORRUPT_DATA',
        message: `Run ${position} has an unreadable eval configuration.`,
      });
    },
  );
});

const run = async <A, E extends Error>(effect: Effect.Effect<A, E>) =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (exit._tag === 'Success') return exit.value;

    for (const reason of exit.cause.reasons) {
      if (reason._tag === 'Fail') throw reason.error;
    }

    throw new Error('Unexpected runtime failure.', { cause: exit.cause });
  });
