import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JsonValue } from '@attest/contracts';

import type { StoredMetricEvaluation } from '../store/index.js';
import {
  METRIC_ERROR_CODES,
  type MetricErrorCode,
  type MetricEvaluation,
} from './metric-evaluation.js';
import {
  StoredMetricEvaluationMappingError,
  fromStoredMetricEvaluation,
  toStoredMetricEvaluation,
} from './stored-metric-evaluation.js';

const knownErrorCodes = METRIC_ERROR_CODES as readonly MetricErrorCode[];
const jsonValueArbitrary = fc.jsonValue() as fc.Arbitrary<JsonValue>;
const finiteNumberArbitrary = fc.double({ noDefaultInfinity: true, noNaN: true });
const durationArbitrary = fc.double({ min: 0, noDefaultInfinity: true, noNaN: true });
const metricNameArbitrary = fc.string({ minLength: 1 });
const metricKindArbitrary = fc.constantFrom<StoredMetricEvaluation['kind']>(
  'assertion',
  'exec',
  'judge',
);
const unknownErrorKindArbitrary = fc
  .string({ minLength: 1 })
  .filter((kind) => !knownErrorCodes.includes(kind as MetricErrorCode));

/** Adds only present optional store fields so the property covers absent fields as well as populated ones. */
const withOptionalFields = <T extends object>(
  required: T,
  fields: { details?: JsonValue; judgeIo?: JsonValue; durationMs?: number; rationale?: string },
): T &
  Partial<Pick<StoredMetricEvaluation, 'details' | 'durationMs' | 'judgeIo' | 'rationale'>> => ({
  ...required,
  ...(fields.details === undefined ? {} : { details: fields.details }),
  ...(fields.judgeIo === undefined ? {} : { judgeIo: fields.judgeIo }),
  ...(fields.durationMs === undefined ? {} : { durationMs: fields.durationMs }),
  ...(fields.rationale === undefined ? {} : { rationale: fields.rationale }),
});

const optionalStoredFieldsArbitrary = fc.record({
  details: fc.option(jsonValueArbitrary, { nil: undefined }),
  judgeIo: fc.option(jsonValueArbitrary, { nil: undefined }),
  durationMs: fc.option(durationArbitrary, { nil: undefined }),
  rationale: fc.option(fc.string(), { nil: undefined }),
});

const storedMetricEvaluationArbitrary: fc.Arbitrary<StoredMetricEvaluation> = fc.oneof(
  fc
    .tuple(
      metricNameArbitrary,
      metricKindArbitrary,
      finiteNumberArbitrary,
      fc.boolean(),
      optionalStoredFieldsArbitrary,
    )
    .map(([metricName, kind, score, pass, fields]) =>
      withOptionalFields({ metricName, kind, status: 'evaluated' as const, score, pass }, fields),
    ),
  fc
    .tuple(
      metricNameArbitrary,
      metricKindArbitrary,
      fc.oneof(fc.constantFrom(...knownErrorCodes), unknownErrorKindArbitrary),
      fc.string({ minLength: 1 }),
      optionalStoredFieldsArbitrary,
    )
    .map(([metricName, kind, errorKind, message, fields]) =>
      withOptionalFields(
        { metricName, kind, status: 'error' as const, error: { kind: errorKind, message } },
        fields,
      ),
    ),
);

const runtimeError: MetricEvaluation = {
  metricName: 'future-provider',
  kind: 'judge',
  status: 'error',
  error: { code: 'future_provider_error', message: 'Provider added a new failure class.' },
  judgeIo: { request: { model: 'future/model' }, rawResponse: { status: 'unavailable' } },
  durationMs: 4,
};

describe('stored metric evaluation mapping', () => {
  it('round-trips arbitrary valid store records without rewriting future error kinds or judge evidence', () => {
    fc.assert(
      fc.property(storedMetricEvaluationArbitrary, (stored) => {
        expect(toStoredMetricEvaluation(fromStoredMetricEvaluation(stored))).toEqual(stored);
      }),
    );
  });

  it('round-trips unknown runtime error kinds and error-side judge I/O', () => {
    expect(fromStoredMetricEvaluation(toStoredMetricEvaluation(runtimeError))).toEqual(
      runtimeError,
    );
  });

  it.each([
    {
      metricName: 'missing-score',
      kind: 'assertion' as const,
      status: 'evaluated' as const,
      pass: true,
    },
    {
      metricName: 'missing-pass',
      kind: 'exec' as const,
      status: 'evaluated' as const,
      score: 1,
    },
    { metricName: 'missing-error', kind: 'judge' as const, status: 'error' as const },
  ])('rejects malformed store arms rather than inventing defaults', (stored) => {
    expect(() => fromStoredMetricEvaluation(stored)).toThrow(StoredMetricEvaluationMappingError);
  });
});
