import { describe, expect, it } from 'vitest';

import type { MetricResultsTable } from '../../schema.js';
import { toMetricEvaluation } from '../row-mapping.js';

const evaluatedRow: MetricResultsTable = {
  id: 'metric-1',
  case_row_id: 'case-1',
  metric_name: 'quality',
  kind: 'assertion',
  status: 'evaluated',
  score: 1,
  pass: 1,
  rationale: null,
  details_json: null,
  error_json: null,
  judge_io_json: null,
  duration_ms: null,
};

describe('metric row mapping', () => {
  it('rejects persisted statuses outside the metric discriminant', () => {
    expect(() =>
      toMetricEvaluation({ ...evaluatedRow, status: 'pending' } as unknown as MetricResultsTable),
    ).toThrow('Stored errored metric violates its discriminant.');
  });

  it.each([-1, 2])('rejects non-boolean persisted pass value %s', (pass) => {
    expect(() => toMetricEvaluation({ ...evaluatedRow, pass })).toThrow(
      'Stored evaluated metric violates its discriminant.',
    );
  });

  it.each([
    [0, false],
    [1, true],
  ])('maps persisted pass value %s to %s', (pass, expected) => {
    expect(toMetricEvaluation({ ...evaluatedRow, pass })).toMatchObject({ pass: expected });
  });
});
