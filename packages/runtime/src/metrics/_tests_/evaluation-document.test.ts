import type { TestCase } from '@attest/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AttestMetricError } from '../errors.js';
import { buildEvaluationDocument, resolveValuePath } from '../evaluation-document.js';
import type { EvaluationDocument } from '../evaluation-document.js';
import { generatedDocumentArbitrary } from './support/arbitraries.js';

const caseDefinition: TestCase = {
  id: 'capital',
  input: { question: 'Capital of France?' },
  expected: { answer: 'Paris' },
};

describe('resolveValuePath', () => {
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
    expect(resolveValuePath(document, path)).toEqual({ found: true, value: expected });
  });

  it.each(['$.input.missing', '$.input.nested.values[4]', '$.output.present'])(
    'reports a miss for %s',
    (path) => {
      expect(resolveValuePath(document, path)).toEqual({ found: false });
    },
  );

  it.each(['input', '$.input.*', '$[x]', '$.input..nested'])(
    'defensively rejects invalid grammar in %s',
    (path) => {
      expect(() => resolveValuePath(document, path)).toThrowError(AttestMetricError);
    },
  );

  it('treats an own undefined property as not found', () => {
    const documentWithUndefinedExpected = Object.defineProperty({ ...document }, 'expected', {
      configurable: true,
      enumerable: true,
      value: undefined,
    });

    expect(resolveValuePath(documentWithUndefinedExpected, '$.expected')).toEqual({
      found: false,
    });
  });
});

describe('buildEvaluationDocument', () => {
  it('maps completed execution output and case fields', () => {
    expect(
      buildEvaluationDocument({
        caseDefinition,
        execution: { outcome: 'completed', output: { answer: 'Paris' }, trace: null },
      }),
    ).toEqual({
      input: caseDefinition.input,
      output: { answer: 'Paris' },
      expected: caseDefinition.expected,
      trace: null,
    });
  });
});

/** Returns what an action throws, so the error's fields can be matched directly. */
const thrownBy = (action: () => void) => {
  try {
    action();
  } catch (error: unknown) {
    return { cause: error };
  }

  return { cause: undefined };
};

type DocumentPathValue = { path: string; value: unknown };

const fieldNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Walks every path expressible by the v0 grammar, retaining its exact value for resolution assertions. */
// BOUNDARY: Generated document values are inspected only for traversable object and array containers.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// BOUNDARY: Generated JSON fields are walked through own keys to produce expected path/value observations.
const collectDocumentPaths = (value: unknown, path = '$'): DocumentPathValue[] => {
  const paths: DocumentPathValue[] = [{ path, value }];

  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      paths.push(...collectDocumentPaths(child, `${path}[${index}]`)),
    );

    return paths;
  }

  if (!isRecord(value)) return paths;

  for (const [key, child] of Object.entries(value)) {
    if (fieldNamePattern.test(key)) paths.push(...collectDocumentPaths(child, `${path}.${key}`));
  }

  return paths;
};

describe('evaluation-document path properties', () => {
  it('resolves every v0-expressible path discovered while walking a generated document', () => {
    fc.assert(
      fc.property(generatedDocumentArbitrary, (generatedDocument) => {
        for (const expected of collectDocumentPaths(generatedDocument)) {
          expect(resolveValuePath(generatedDocument, expected.path)).toEqual({
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
          expect(resolveValuePath(document, missingPath)).toEqual({ found: false });
        },
      ),
    );
  });

  it('rejects generated malformed path strings with the typed invalid_path error', () => {
    fc.assert(
      fc.property(
        fc.string().filter((path) => !/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/.test(path)),
        (path) => {
          expect(
            thrownBy(() => resolveValuePath({ input: null, trace: null }, path)).cause,
          ).toMatchObject({
            code: 'invalid_path',
          });
        },
      ),
    );
  });
});
