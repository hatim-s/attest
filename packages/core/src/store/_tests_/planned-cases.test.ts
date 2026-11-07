import { readFileSync } from 'node:fs';
import { EVAL_RUN_SCHEMA_ID, evalRunSchema, parseWithSchemaSync } from '@attest/contracts';
import { expect, it } from 'vitest';
import { plannedSuiteCases } from '../planned-cases.js';

it('parses public snapshots, preserves selected zero counts, and rejects contradictory identities', () => {
  const fixture = parseWithSchemaSync(
    evalRunSchema,
    JSON.parse(
      readFileSync(
        new URL(
          '../../../../contracts/src/_tests_/fixtures/eval-run/eval-run.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  );

  expect(plannedSuiteCases(EVAL_RUN_SCHEMA_ID, JSON.stringify(fixture))?.get('refund')).toBe(2);
  fixture.snapshot.selected_test_ids.push('empty');
  expect(plannedSuiteCases(EVAL_RUN_SCHEMA_ID, JSON.stringify(fixture))?.get('empty')).toBe(0);
  fixture.snapshot.selected_cases.push(fixture.snapshot.selected_cases[0]!);
  expect(() => plannedSuiteCases(EVAL_RUN_SCHEMA_ID, JSON.stringify(fixture))).toThrow(
    'identities',
  );
  expect(plannedSuiteCases('legacy', 'opaque')).toBeNull();
  expect(() => plannedSuiteCases(EVAL_RUN_SCHEMA_ID, '{}')).toThrow();
});
