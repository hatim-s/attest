import type { JsonValue, TestCase } from '@attest/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AttestMetricError } from '../errors.js';
import { buildEvaluationDocument, resolveDocumentPath } from '../evaluation-document.js';
import type { EvaluationDocument } from '../evaluation-document.js';
import type { MetricContext } from '../metric-evaluation.js';

const caseDefinition: TestCase = {
  id: 'capital',
  input: { question: 'Capital of France?' },
  expected: { answer: 'Paris' },
};

describe('resolveDocumentPath', () => {
  const document: EvaluationDocument = {
    input: { nested: { values: [{ answer: 'Paris' }] } },
    output: ['first', { present: null }],
    trace: null,
  };

  it.each([
    ['$', document],
    ['$.input.nested.values[0].answer', 'Paris'],
    ['$.output[1].present', null],
  ])('resolves %s', (path, expected) => {
    expect(resolveDocumentPath(document, path)).toEqual({ found: true, value: expected });
  });

  it.each(['$.input.missing', '$.input.nested.values[4]', '$.output.present'])(
    'reports a miss for %s',
    (path) => {
      expect(resolveDocumentPath(document, path)).toEqual({ found: false });
    },
  );

  it.each(['input', '$.input.*', '$[x]', '$.input..nested'])(
    'defensively rejects invalid grammar in %s',
    (path) => {
      expect(() => resolveDocumentPath(document, path)).toThrowError(AttestMetricError);
    },
  );

  it('treats an own undefined property as not found', () => {
    const documentWithUndefinedExpected = Object.defineProperty({ ...document }, 'expected', {
      configurable: true,
      enumerable: true,
      value: undefined,
    });

    expect(resolveDocumentPath(documentWithUndefinedExpected, '$.expected')).toEqual({
      found: false,
    });
  });
});

describe('buildEvaluationDocument', () => {
  it('maps completed execution output and case fields', () => {
    const context: MetricContext = {
      caseDefinition,
      execution: { outcome: 'completed', output: { answer: 'Paris' }, trace: null },
    };

    expect(buildEvaluationDocument(context)).toEqual({
      input: caseDefinition.input,
      output: { answer: 'Paris' },
      expected: caseDefinition.expected,
      trace: null,
    });
  });

  it.each(['invocation_error', 'timeout', 'cancelled'] as const)(
    'hides output after a %s outcome',
    (outcome) => {
      const context: MetricContext = {
        caseDefinition,
        execution: { outcome, output: 'partial output', trace: null },
      };

      expect(buildEvaluationDocument(context)).not.toHaveProperty('output');
    },
  );

  it('omits an absent expected value rather than materializing undefined', () => {
    const context: MetricContext = {
      caseDefinition: { ...caseDefinition, expected: undefined },
      execution: { outcome: 'completed', output: { answer: 'Paris' }, trace: null },
    };

    expect(buildEvaluationDocument(context)).not.toHaveProperty('expected');
  });
});

/** Narrows generated values before treating them as contract JSON. */
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
const generatedDocumentArbitrary: fc.Arbitrary<EvaluationDocument> = fc
  .record({
    input: jsonValueArbitrary,
    output: fc.option(jsonValueArbitrary, { nil: undefined }),
    expected: fc.option(jsonValueArbitrary, { nil: undefined }),
  })
  .map(({ input, output, expected }) => ({
    input,
    ...(output === undefined ? {} : { output }),
    ...(expected === undefined ? {} : { expected }),
    trace: null,
  }));

type DocumentPathValue = { path: string; value: unknown };
const fieldNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Walks every path expressible by the v0 grammar, retaining its exact value for resolution assertions. */
const collectDocumentPaths = (value: unknown, path = '$'): DocumentPathValue[] => {
  const paths: DocumentPathValue[] = [{ path, value }];
  if (Array.isArray(value)) {
    return value.reduce<DocumentPathValue[]>(
      (allPaths, child, index) => allPaths.concat(collectDocumentPaths(child, `${path}[${index}]`)),
      paths,
    );
  }
  if (value === null || typeof value !== 'object') {
    return paths;
  }
  return Object.entries(value).reduce<DocumentPathValue[]>((allPaths, [key, child]) => {
    if (!fieldNamePattern.test(key)) {
      return allPaths;
    }
    return allPaths.concat(collectDocumentPaths(child, `${path}.${key}`));
  }, paths);
};

describe('evaluation-document path properties', () => {
  it('resolves every v0-expressible path discovered while walking a generated document', () => {
    fc.assert(
      fc.property(generatedDocumentArbitrary, (generatedDocument) => {
        for (const expected of collectDocumentPaths(generatedDocument)) {
          expect(resolveDocumentPath(generatedDocument, expected.path)).toEqual({
            found: true,
            value: expected.value,
          });
        }
      }),
    );
  });

  it('does not resolve generated valid paths outside the document walk', () => {
    fc.assert(
      fc.property(
        generatedDocumentArbitrary,
        fc.stringMatching(/^[A-Za-z0-9_]{1,12}$/),
        (document, suffix) => {
          const missingPath = `$.__attest_missing_${suffix}`;
          expect(collectDocumentPaths(document).some(({ path }) => path === missingPath)).toBe(
            false,
          );
          expect(resolveDocumentPath(document, missingPath)).toEqual({ found: false });
        },
      ),
    );
  });

  it('rejects generated malformed path strings with the typed invalid_path error', () => {
    fc.assert(
      fc.property(
        fc.string().filter((path) => !/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/.test(path)),
        (path) => {
          expect(() => resolveDocumentPath({ input: null, trace: null }, path)).toThrowError(
            AttestMetricError,
          );
          try {
            resolveDocumentPath({ input: null, trace: null }, path);
          } catch (error: unknown) {
            expect(error).toMatchObject({ code: 'invalid_path' });
          }
        },
      ),
    );
  });
});
