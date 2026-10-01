import { describe, expect, it } from 'vitest';

import {
  assertionCheckSchema,
  metricDefinitionSchema,
  metricRequestSchema,
  metricResultSchema,
} from '../metric/protocol.js';
import { parseMetricRequest, parseMetricResult } from '../schema/parse.js';
import { METRIC_PROTOCOL } from '../schema/identifiers.js';

describe('metric schemas', () => {
  it('accepts a complete executable metric request', () => {
    const result = metricRequestSchema.safeParse({
      protocol: METRIC_PROTOCOL,
      case: { id: 'greeting', input: {}, expected: {}, params: {} },
      output: 'Paris',
      trace: null,
    });

    expect(result.success).toBe(true);
    expect(parseMetricRequest(result.data).ok).toBe(true);
  });

  it('accepts a complete normalized result', () => {
    expect(
      metricResultSchema.safeParse({
        score: 1,
        pass: true,
        rationale: 'The answer matches.',
        details: { matched: ['$.output'] },
      }).success,
    ).toBe(true);
  });

  it('rejects a result missing pass at the pass field', () => {
    const result = parseMetricResult({ score: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error[0]?.path).toBe('pass');
  });

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

  it('requires threshold comparisons and exactly one executable target', () => {
    expect(assertionCheckSchema.safeParse({ threshold: { path: '$.score' } }).success).toBe(false);
    expect(metricDefinitionSchema.safeParse({ name: 'custom', type: 'exec' }).success).toBe(false);
    expect(
      metricDefinitionSchema.safeParse({
        name: 'custom',
        type: 'exec',
        command: ['bun'],
        url: 'https://example.com/metric',
      }).success,
    ).toBe(false);
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

  it('accepts all three metric definition variants', () => {
    const definitions = [
      { name: 'exists', type: 'assertion', assert: [{ exists: { path: '$.output' } }] },
      { name: 'custom', type: 'exec', command: ['python3', 'metric.py'] },
      { name: 'judge', type: 'judge', model: 'openai/gpt-5', rubric: 'Score it.' },
    ];

    for (const definition of definitions) {
      expect(metricDefinitionSchema.safeParse(definition).success).toBe(true);
    }
  });

  it.each([
    { name: 'assert', value: { name: 'empty', type: 'assertion', assert: [] } },
    { name: 'all', value: { all: [] } },
    { name: 'any', value: { any: [] } },
    { name: 'arguments', value: { tool_calls: { arguments: [] } } },
  ])('rejects an empty $name list', ({ name, value }) => {
    const result =
      name === 'assert'
        ? metricDefinitionSchema.safeParse(value)
        : assertionCheckSchema.safeParse(value);

    expect(result.success).toBe(false);
  });
});
