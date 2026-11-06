import { parseWithSchema } from '../schema/parse.js';
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

    expect(parseWithSchema(assertionCheckSchema, check).ok).toBe(true);
  });

  it('validates JSON paths, JSON Schema booleans, and regular expressions', () => {
    expect(parseWithSchema(assertionCheckSchema, { exists: { path: '$.a.b[0]' } }).ok).toBe(true);
    expect(parseWithSchema(assertionCheckSchema, { exists: { path: '$..a' } }).ok).toBe(false);
    expect(parseWithSchema(assertionCheckSchema, { exists: { path: '$.items[*]' } }).ok).toBe(
      false,
    );
    expect(parseWithSchema(assertionCheckSchema, { exists: { path: '$[' } }).ok).toBe(false);
    expect(
      parseWithSchema(assertionCheckSchema, { json_schema: { path: '$.value', schema: true } }).ok,
    ).toBe(true);
    expect(
      parseWithSchema(assertionCheckSchema, {
        regex: { path: '$.value', pattern: 'capital', flags: 'i' },
      }).ok,
    ).toBe(true);
    expect(
      parseWithSchema(assertionCheckSchema, {
        regex: { path: '$.value', pattern: 'capital', flags: 'x' },
      }).ok,
    ).toBe(false);
    expect(
      parseWithSchema(assertionCheckSchema, {
        regex: { path: '$.value', pattern: '[', flags: 'i' },
      }).ok,
    ).toBe(false);
  });

  it('requires at least one threshold comparison', () => {
    expect(parseWithSchema(assertionCheckSchema, { threshold: { path: '$.score' } }).ok).toBe(
      false,
    );
  });

  it('accepts tool argument matchers and stable span filters', () => {
    expect(
      parseWithSchema(assertionCheckSchema, {
        tool_calls: {
          name: 'search',
          arguments: [
            { equals: { path: '$.limit', value: 5 } },
            { contains: { path: '$.query', value: 'France' } },
            { exists: { path: '$.query' } },
          ],
        },
      }).ok,
    ).toBe(true);
    expect(
      parseWithSchema(assertionCheckSchema, {
        spans: {
          filter: {
            kind: 'tool',
            status: 'ok',
            attributes: { 'attest.step.index': 1 },
          },
          count: 1,
          order: ['tool.search'],
        },
      }).ok,
    ).toBe(true);
    expect(
      parseWithSchema(assertionCheckSchema, {
        tool_calls: { arguments: [{ equals: { path: '$.*', value: 5 } }] },
      }).ok,
    ).toBe(false);
  });

  it.each([
    { name: 'all', value: { all: [] } },
    { name: 'any', value: { any: [] } },
    { name: 'arguments', value: { tool_calls: { arguments: [] } } },
  ])('rejects an empty $name list', ({ value }) => {
    expect(parseWithSchema(assertionCheckSchema, value).ok).toBe(false);
  });
});

describe('metric request artifacts', () => {
  it('accepts inline artifacts with or without a materialized directory', () => {
    expect(parseWithSchema(metricRequestSchema, metricRequest).ok).toBe(true);
    expect(parseWithSchema(metricRequestSchema, { ...metricRequest, artifact_dir: null }).ok).toBe(
      true,
    );
  });

  it.each([
    { ...metricRequest, artifacts: undefined },
    { ...metricRequest, artifact_dir: undefined },
    { ...metricRequest, artifacts: [{ kind: 'reference', path: 'answer.ts', id: 'blob-1' }] },
  ])('rejects a request without inline artifacts and a directory in %#', (candidate) => {
    expect(parseWithSchema(metricRequestSchema, candidate).ok).toBe(false);
  });
});
