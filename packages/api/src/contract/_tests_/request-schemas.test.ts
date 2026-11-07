import { parseWithSchema, parseWithSchemaSync, SchemaDecodeError } from '@attest/contracts';
import { describe, expect, it } from 'vitest';
import {
  pageQuerySchema,
  suiteHistoryQuerySchema,
  runStartRequestSchema,
  diffParamsSchema,
} from '../requests.js';

/** Exercises the wire coercion and strictness policies rather than decoder call routing. */
describe('native request schemas', () => {
  it('keeps page coercion, defaulting and stripping independent of numeric bounds', () => {
    expect(parseWithSchemaSync(pageQuerySchema, { extra: true })).toEqual({ limit: 100 });
    expect(parseWithSchemaSync(pageQuerySchema, { limit: '12', cursor: 'opaque' })).toEqual({
      limit: 12,
      cursor: 'opaque',
    });

    for (const limit of ['', null, '1.5', '1001', 'bad']) {
      expect(parseWithSchema(pageQuerySchema, { limit }).ok).toBe(false);
    }

    expect(parseWithSchemaSync(suiteHistoryQuerySchema, {})).toEqual({ limit: 20 });
    expect(parseWithSchemaSync(suiteHistoryQuerySchema, { limit: '50' })).toEqual({ limit: 50 });
    expect(parseWithSchema(suiteHistoryQuerySchema, { limit: '51' }).ok).toBe(false);
  });

  it('rejects mixed run selections and extra request fields while preserving authored errors', () => {
    for (const input of [
      { selection: { all: true, testIds: ['one'] } },
      { selection: { all: true }, extra: true },
      { selection: { all: true }, concurrency: 0 },
    ])
      expect(parseWithSchema(runStartRequestSchema, input).ok).toBe(false);
    expect(parseWithSchemaSync(runStartRequestSchema, { selection: { all: true } })).toEqual({
      selection: { all: true },
    });
    expect(() =>
      parseWithSchemaSync(diffParamsSchema, {
        projectKey: 'demo',
        baseRunId: 'one',
        candidateRunId: 'one',
      }),
    ).toThrow(SchemaDecodeError);

    const invalid = parseWithSchema(diffParamsSchema, {
      projectKey: 'demo',
      baseRunId: 'one',
      candidateRunId: 'one',
    });

    if (invalid.ok) throw new Error('Expected identical run IDs to fail.');
    expect(invalid.error.issues.map((issue) => issue.message)).toContain(
      'baseRunId and candidateRunId must differ.',
    );
  });
});
