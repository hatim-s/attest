import type { AssertionCheck, JsonValue, Trace } from '@attest/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  evaluateAssertionCheck,
  evaluateAssertionMetric,
  type AssertionMetricDefinition,
} from './assertion-engine.js';
import type { EvaluationDocument } from './evaluation-document.js';

const trace: Trace = {
  schema: 'attest.trace/v1alpha1',
  trace_id: 'trace-1',
  spans: [
    {
      span_id: 'tool-2',
      parent_span_id: null,
      name: 'tool.search',
      kind: 'tool',
      start_time: '2026-08-06T10:00:02Z',
      end_time: '2026-08-06T10:00:03Z',
      status: { code: 'error' },
      attributes: {
        'gen_ai.tool.name': 'search',
        'gen_ai.tool.call.arguments': '{"query":"capital of France","limit":5}',
      },
    },
    {
      span_id: 'agent-1',
      parent_span_id: null,
      name: 'answer',
      kind: 'agent',
      start_time: '2026-08-06T10:00:00Z',
      end_time: '2026-08-06T10:00:04Z',
      status: { code: 'ok' },
    },
    {
      span_id: 'tool-1',
      parent_span_id: 'agent-1',
      name: 'lookup',
      kind: 'tool',
      start_time: '2026-08-06T10:00:01Z',
      end_time: '2026-08-06T10:00:02Z',
      status: { code: 'ok' },
      attributes: {
        'gen_ai.tool.name': 'lookup',
        'gen_ai.tool.call.arguments': '{"cities":["Paris","London"]}',
        'attest.step.index': 1,
      },
    },
  ],
};

const document: EvaluationDocument = {
  input: { query: 'capital' },
  output: {
    answer: 'Paris is the capital of France',
    facts: [{ city: 'Paris' }, 'France'],
    confidence: 0.9,
    metadata: { citations: 2 },
  },
  expected: { answer: 'Paris' },
  trace,
};

type LeafCase = {
  name: string;
  check: AssertionCheck;
  passed: boolean;
  reason?: RegExp;
  customDocument?: EvaluationDocument;
};

const leafCases: LeafCase[] = [
  {
    name: 'equals deep-compares JSON objects',
    check: { equals: { path: '$.output.metadata', value: { citations: 2 } } },
    passed: true,
  },
  {
    name: 'equals reports a missing path',
    check: { equals: { path: '$.output.missing', value: null } },
    passed: false,
    reason: /\$\.output\.missing.*not found/,
  },
  {
    name: 'contains finds a string substring',
    check: { contains: { path: '$.output.answer', value: 'capital' } },
    passed: true,
  },
  {
    name: 'contains deep-compares array elements',
    check: { contains: { path: '$.output.facts', value: { city: 'Paris' } } },
    passed: true,
  },
  {
    name: 'contains rejects unsupported targets',
    check: { contains: { path: '$.output.confidence', value: 0.9 } },
    passed: false,
    reason: /must be a string or array/,
  },
  {
    name: 'contains requires a string needle for string targets',
    check: { contains: { path: '$.output.answer', value: 2 } },
    passed: false,
    reason: /requires a string value/,
  },
  {
    name: 'regex matches a string target',
    check: { regex: { path: '$.output.answer', pattern: '^Paris', flags: 'i' } },
    passed: true,
  },
  {
    name: 'regex rejects a non-string target',
    check: { regex: { path: '$.output.confidence', pattern: '9' } },
    passed: false,
    reason: /must be a string/,
  },
  {
    name: 'regex reports oversized input as a failure',
    check: { regex: { path: '$.output', pattern: '.' } },
    customDocument: { ...document, output: 'a'.repeat(65_537) },
    passed: false,
    reason: /65536-byte limit/,
  },
  {
    name: 'json_schema accepts a Draft 2020-12-valid value',
    check: {
      json_schema: {
        path: '$.output.metadata',
        schema: {
          type: 'object',
          required: ['citations'],
          properties: { citations: { type: 'number' } },
        },
      },
    },
    passed: true,
  },
  {
    name: 'json_schema returns Ajv errors for invalid values',
    check: {
      json_schema: {
        path: '$.output.metadata',
        schema: { type: 'object', required: ['source'] },
      },
    },
    passed: false,
    reason: /required property 'source'/,
  },
  {
    name: 'threshold requires every present comparator',
    check: { threshold: { path: '$.output.confidence', gt: 0.5, gte: 0.9, lt: 1, lte: 0.9 } },
    passed: true,
  },
  {
    name: 'threshold reports a failed comparator',
    check: { threshold: { path: '$.output.confidence', lt: 0.5 } },
    passed: false,
    reason: /every threshold comparator/,
  },
  {
    name: 'threshold rejects non-numeric values',
    check: { threshold: { path: '$.output.answer', gt: 0 } },
    passed: false,
    reason: /finite number/,
  },
  {
    name: 'exists recognizes a present null value',
    check: { exists: { path: '$.trace.spans[0].parent_span_id' } },
    passed: true,
  },
  {
    name: 'exists reports an absent path',
    check: { exists: { path: '$.expected.missing' } },
    passed: false,
    reason: /not found/,
  },
  {
    name: 'tool_calls filters by name',
    check: { tool_calls: { name: 'lookup' } },
    passed: true,
  },
  {
    name: 'tool_calls reports a filtered tool that was never called',
    check: { tool_calls: { name: 'write' } },
    passed: false,
    reason: /tool never called/,
  },
  {
    name: 'tool_calls requires every candidate status to match',
    check: { tool_calls: { status: 'ok' } },
    passed: false,
    reason: /not every.*status ok/,
  },
  {
    name: 'tool_calls applies status after a name filter',
    check: { tool_calls: { name: 'lookup', status: 'ok' } },
    passed: true,
  },
  {
    name: 'tool_calls checks exact candidate count',
    check: { tool_calls: { count: 2 } },
    passed: true,
  },
  {
    name: 'tool_calls checks chronological name order',
    check: { tool_calls: { order: ['lookup', 'search'] } },
    passed: true,
  },
  {
    name: 'tool_calls rejects a different order',
    check: { tool_calls: { order: ['search', 'lookup'] } },
    passed: false,
    reason: /order did not match/,
  },
  {
    name: 'tool_calls matches structured argument equality and containment',
    check: {
      tool_calls: {
        name: 'search',
        arguments: [
          { equals: { path: '$.limit', value: 5 } },
          { contains: { path: '$.query', value: 'France' } },
          { exists: { path: '$.query' } },
        ],
      },
    },
    passed: true,
  },
  {
    name: 'tool_calls reports argument mismatches as assertion failures',
    check: {
      tool_calls: {
        name: 'search',
        arguments: [{ equals: { path: '$.limit', value: 10 } }],
      },
    },
    passed: false,
    reason: /arguments satisfied every argument matcher/,
  },
  {
    name: 'spans filters by kind, status, and partial attributes',
    check: {
      spans: {
        filter: { kind: 'tool', status: 'ok', attributes: { 'attest.step.index': 1 } },
        count: 1,
        order: ['lookup'],
      },
    },
    passed: true,
  },
  {
    name: 'spans reports filtered count mismatches',
    check: { spans: { filter: { kind: 'tool', status: 'error' }, count: 0 } },
    passed: false,
    reason: /expected 0 matching spans but found 1/,
  },
  {
    name: 'spans treats a filter-only check as an existence assertion',
    check: { spans: { filter: { kind: 'retrieval' } } },
    passed: false,
    reason: /no spans matched the filter/,
  },
  {
    name: 'tool_calls fails when no trace was emitted',
    check: { tool_calls: { count: 0 } },
    customDocument: { ...document, trace: null },
    passed: false,
    reason: /no trace emitted/,
  },
];

describe('evaluateAssertionCheck', () => {
  it.each(leafCases)('$name', ({ check, passed, reason, customDocument }) => {
    const outcome = evaluateAssertionCheck(check, customDocument ?? document);

    expect(outcome.passed).toBe(passed);
    if (reason === undefined) {
      expect(outcome.reason).toBeUndefined();
    } else {
      expect(outcome.reason).toMatch(reason);
    }
  });

  it('composes nested not and any checks', () => {
    const check: AssertionCheck = {
      not: {
        any: [
          { equals: { path: '$.output.confidence', value: 0 } },
          { contains: { path: '$.output.answer', value: 'London' } },
        ],
      },
    };

    expect(evaluateAssertionCheck(check, document)).toEqual({ check, passed: true });
  });

  it('aggregates failed child reasons for combinators', () => {
    const check: AssertionCheck = {
      all: [{ exists: { path: '$.output.answer' } }, { exists: { path: '$.output.missing' } }],
    };

    const outcome = evaluateAssertionCheck(check, document);
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain('$.output.missing');
  });
});

describe('evaluateAssertionMetric', () => {
  it('computes the top-level pass fraction and index-aligned details', () => {
    const definition: AssertionMetricDefinition = {
      name: 'answer-quality',
      type: 'assertion',
      assert: [
        { exists: { path: '$.output.answer' } },
        { equals: { path: '$.output.confidence', value: 0 } },
        { threshold: { path: '$.output.confidence', gte: 0.8 } },
      ],
    };

    const result = evaluateAssertionMetric(definition, document);

    expect(result.score).toBe(2 / 3);
    expect(result.pass).toBe(false);
    const checks = result.details as { checks: { passed: boolean; reason?: string }[] };
    expect(checks.checks.map(({ passed }) => passed)).toEqual([true, false, true]);
    expect(typeof checks.checks[1]?.reason).toBe('string');
  });

  it('fails exists when expected is absent from the evaluation document', () => {
    const absentExpectedDocument: EvaluationDocument = {
      input: document.input,
      output: document.output,
      trace: document.trace,
    };

    expect(
      evaluateAssertionCheck({ exists: { path: '$.expected' } }, absentExpectedDocument),
    ).toMatchObject({
      passed: false,
      reason: 'path $.expected was not found',
    });
  });

  it('fails a permissive JSON Schema when its root path is absent', () => {
    const absentExpectedDocument: EvaluationDocument = {
      input: document.input,
      output: document.output,
      trace: document.trace,
    };

    expect(
      evaluateAssertionCheck(
        { json_schema: { path: '$.expected', schema: {} } },
        absentExpectedDocument,
      ),
    ).toMatchObject({ passed: false, reason: 'path $.expected was not found' });
  });

  it('throws a typed error when JSON Schema configuration cannot compile', () => {
    const definition: AssertionMetricDefinition = {
      name: 'invalid-schema',
      type: 'assertion',
      assert: [
        {
          json_schema: {
            path: '$.output.metadata',
            schema: { type: 'not-a-json-schema-type' },
          },
        },
      ],
    };

    expect(() => evaluateAssertionMetric(definition, document)).toThrowError(
      /JSON Schema could not be compiled/,
    );
    try {
      evaluateAssertionMetric(definition, document);
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'invalid_json_schema' });
    }
  });

  it('isolates schemas that share an identifier', () => {
    const sharedIdentifier = 'https://attest.dev/schema/shared';
    const first = evaluateAssertionMetric(
      {
        name: 'first-schema',
        type: 'assertion',
        assert: [
          {
            json_schema: {
              path: '$.output.metadata',
              schema: { $id: sharedIdentifier, type: 'object', required: ['citations'] },
            },
          },
        ],
      },
      document,
    );
    const second = evaluateAssertionMetric(
      {
        name: 'second-schema',
        type: 'assertion',
        assert: [
          {
            json_schema: {
              path: '$.output.metadata',
              schema: { $id: sharedIdentifier, type: 'object', required: ['source'] },
            },
          },
        ],
      },
      document,
    );

    expect(first.pass).toBe(true);
    expect(second.pass).toBe(false);
  });
});

/** Narrows fast-check's unknown JSON generator using the same recursive JSON value boundary as the contract. */
const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === 'object') {
    return Object.values(value).every(isJsonValue);
  }
  return false;
};

const toJsonValue = (value: unknown): JsonValue => {
  if (!isJsonValue(value)) {
    throw new Error('fast-check generated a non-JSON value');
  }
  return value;
};

const jsonValueArbitrary: fc.Arbitrary<JsonValue> = fc.jsonValue().map(toJsonValue);
const generatedDocumentArbitrary: fc.Arbitrary<EvaluationDocument> = fc.record({
  input: jsonValueArbitrary,
  output: fc.option(jsonValueArbitrary, { nil: undefined }),
  expected: fc.option(jsonValueArbitrary, { nil: undefined }),
  trace: fc.constant(null),
});
const leafCheckArbitrary: fc.Arbitrary<AssertionCheck> = fc.oneof(
  jsonValueArbitrary.map((value) => ({ equals: { path: '$.input', value } })),
  fc.string().map((value) => ({ contains: { path: '$.input', value } })),
  fc.constant({ regex: { path: '$.input', pattern: 'a' } }),
  fc.constant({ json_schema: { path: '$.input', schema: true } }),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map((gt) => ({
    threshold: { path: '$.input', gt },
  })),
  fc.constant({ exists: { path: '$.input' } }),
  fc.constant({ tool_calls: { count: 0 } }),
  fc.constant({ spans: { count: 0 } }),
);

describe('assertion properties', () => {
  it('not inverts generated leaf check verdicts', () => {
    fc.assert(
      fc.property(leafCheckArbitrary, generatedDocumentArbitrary, (check, generatedDocument) => {
        const child = evaluateAssertionCheck(check, generatedDocument);
        const negated = evaluateAssertionCheck({ not: check }, generatedDocument);
        expect(negated.passed).toBe(!child.passed);
      }),
    );
  });

  it('single-child all and any preserve the generated child verdict', () => {
    fc.assert(
      fc.property(leafCheckArbitrary, generatedDocumentArbitrary, (check, generatedDocument) => {
        const child = evaluateAssertionCheck(check, generatedDocument);
        expect(evaluateAssertionCheck({ all: [check] }, generatedDocument).passed).toBe(
          child.passed,
        );
        expect(evaluateAssertionCheck({ any: [check] }, generatedDocument).passed).toBe(
          child.passed,
        );
      }),
    );
  });
});

describe('tool-call ordering', () => {
  it('orders mixed timestamp precision by parsed instant', () => {
    const mixedPrecisionTrace: Trace = {
      schema: 'attest.trace/v1alpha1',
      trace_id: 'trace-mixed-precision',
      spans: [
        {
          span_id: 'tool-whole-second',
          parent_span_id: null,
          name: 'whole-second',
          kind: 'tool',
          start_time: '2026-08-06T10:00:00Z',
          end_time: '2026-08-06T10:00:01Z',
          status: { code: 'ok' },
        },
        {
          span_id: 'tool-fractional-second',
          parent_span_id: null,
          name: 'fractional-second',
          kind: 'tool',
          start_time: '2026-08-06T10:00:00.100Z',
          end_time: '2026-08-06T10:00:01Z',
          status: { code: 'ok' },
        },
      ],
    };

    expect(
      evaluateAssertionCheck(
        { tool_calls: { order: ['whole-second', 'fractional-second'] } },
        { ...document, trace: mixedPrecisionTrace },
      ),
    ).toMatchObject({ passed: true });
  });
});
