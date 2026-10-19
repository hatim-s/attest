import { describe, expect, it } from 'vitest';

import { assertionCheckSchema, metricRequestSchema } from '../metric/protocol.js';
import { METRIC_PROTOCOL } from '../schema/identifiers.js';

const metricRequest = {
  protocol: METRIC_PROTOCOL,
  case: { id: 'greeting', input: {} },
  output: 'Paris',
  trace: null,
  artifacts: [
    {
      kind: 'inline',
      path: 'answer.ts',
      media_type: 'text/typescript',
      encoding: 'utf8',
      content: 'export const answer = 42;\n',
    },
  ],
  artifact_dir: '/tmp/attest-metric-abc123',
};

describe('metric schemas', () => {
  it('parses recursive assertion combinators', () => {
    const check = {
      all: [
        { exists: { path: '$.output' } },
        {
          any: [
            { equals: { path: '$.output.answer', value: 'Paris' } },
            { not: { contains: { path: '$.output', value: "I don't know" } } },
          ],
        },
      ],
    };

    expect(assertionCheckSchema.safeParse(check).success).toBe(true);
  });

  it('validates JSON paths, JSON Schema booleans, and regular expressions', () => {
    expect(assertionCheckSchema.safeParse({ exists: { path: '$.a.b[0]' } }).success).toBe(true);
    expect(assertionCheckSchema.safeParse({ exists: { path: '$..a' } }).success).toBe(false);
    expect(assertionCheckSchema.safeParse({ exists: { path: '$.items[*]' } }).success).toBe(false);
    expect(assertionCheckSchema.safeParse({ exists: { path: '$[' } }).success).toBe(false);
    expect(
      assertionCheckSchema.safeParse({ json_schema: { path: '$.value', schema: true } }).success,
    ).toBe(true);
    expect(
      assertionCheckSchema.safeParse({
        regex: { path: '$.value', pattern: 'capital', flags: 'i' },
      }).success,
    ).toBe(true);
    expect(
      assertionCheckSchema.safeParse({ regex: { path: '$.value', pattern: 'capital', flags: 'x' } })
        .success,
    ).toBe(false);
    expect(
      assertionCheckSchema.safeParse({ regex: { path: '$.value', pattern: '[', flags: 'i' } })
        .success,
    ).toBe(false);
  });

  it('requires at least one threshold comparison', () => {
    expect(assertionCheckSchema.safeParse({ threshold: { path: '$.score' } }).success).toBe(false);
  });

  it('accepts tool argument matchers and stable span filters', () => {
    expect(
      assertionCheckSchema.safeParse({
        tool_calls: {
          name: 'search',
          arguments: [
            { equals: { path: '$.limit', value: 5 } },
            { contains: { path: '$.query', value: 'France' } },
            { exists: { path: '$.query' } },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      assertionCheckSchema.safeParse({
        spans: {
          filter: {
            kind: 'tool',
            status: 'ok',
            attributes: { 'attest.step.index': 1 },
          },
          count: 1,
          order: ['tool.search'],
        },
      }).success,
    ).toBe(true);
    expect(
      assertionCheckSchema.safeParse({
        tool_calls: { arguments: [{ equals: { path: '$.*', value: 5 } }] },
      }).success,
    ).toBe(false);
  });

  it.each([
    { name: 'all', value: { all: [] } },
    { name: 'any', value: { any: [] } },
    { name: 'arguments', value: { tool_calls: { arguments: [] } } },
  ])('rejects an empty $name list', ({ value }) => {
    expect(assertionCheckSchema.safeParse(value).success).toBe(false);
  });
});

describe('metric request artifacts', () => {
  it('accepts inline artifacts with or without a materialized directory', () => {
    expect(metricRequestSchema.safeParse(metricRequest).success).toBe(true);
    expect(metricRequestSchema.safeParse({ ...metricRequest, artifact_dir: null }).success).toBe(
      true,
    );
  });

  it.each([
    { ...metricRequest, artifacts: undefined },
    { ...metricRequest, artifact_dir: undefined },
    { ...metricRequest, artifacts: [{ kind: 'reference', path: 'answer.ts', id: 'blob-1' }] },
  ])('rejects a request without inline artifacts and a directory in %#', (candidate) => {
    expect(metricRequestSchema.safeParse(candidate).success).toBe(false);
  });
});
