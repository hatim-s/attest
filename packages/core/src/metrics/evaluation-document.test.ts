import type { CaseDefinition } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { AttestMetricError } from './errors.js';
import { buildEvaluationDocument, resolveDocumentPath } from './evaluation-document.js';
import type { MetricContext } from './metric-evaluation.js';

const caseDefinition: CaseDefinition = {
  id: 'capital',
  input: { question: 'Capital of France?' },
  expected: { answer: 'Paris' },
};

describe('resolveDocumentPath', () => {
  const document = {
    input: { nested: { values: [{ answer: 'Paris' }] } },
    output: ['first', { present: null }],
    expected: undefined,
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

      expect(buildEvaluationDocument(context).output).toBeUndefined();
    },
  );
});
