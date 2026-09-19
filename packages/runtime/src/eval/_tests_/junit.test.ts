import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createEvalJUnitPayload } from '../junit.js';
import type { NormalizedEvalCaseResult } from '../types.js';

/** Builds the smallest normalized case needed to probe deterministic and hostile XML output. */
const evalCase = (
  configuredIndex: number,
  caseId: string,
  verdict: NormalizedEvalCaseResult['verdict'],
): NormalizedEvalCaseResult => ({
  test_id: 'refund<&',
  case_id: caseId,
  configured_index: configuredIndex,
  completion_index: 2 - configuredIndex,
  outcome: 'completed',
  verdict,
  started_at: '2026-08-08T10:00:00.000Z',
  duration_ms: 125,
  attempts: [],
  metric_results: [
    verdict === 'error'
      ? {
          metric_name: 'correct',
          kind: 'assertion',
          status: 'error',
          error: { code: 'internal_error', message: 'bad <metric>\u0000' },
        }
      : {
          metric_name: 'correct',
          kind: 'assertion',
          status: 'evaluated',
          score: verdict === 'pass' ? 1 : 0,
          pass: verdict === 'pass',
        },
  ],
});

describe('createEvalJUnitPayload', () => {
  it('uses configured order, escapes XML, strips invalid code points, and hashes exact bytes', () => {
    const payload = createEvalJUnitPayload('run<&', [
      evalCase(2, 'case-three', 'error'),
      evalCase(0, 'case-one', 'pass'),
      evalCase(1, 'case-two', 'fail'),
    ]);

    expect(payload.contents.indexOf('case-one')).toBeLessThan(payload.contents.indexOf('case-two'));
    expect(payload.contents.indexOf('case-two')).toBeLessThan(
      payload.contents.indexOf('case-three'),
    );
    expect(payload.contents).toContain('name="run&lt;&amp;"');
    expect(payload.contents).toContain('name="refund&lt;&amp;" tests="3" failures="1" errors="1"');
    expect(payload.contents).not.toContain('\u0000');
    expect(payload.byte_length).toBe(Buffer.byteLength(payload.contents, 'utf8'));
    expect(payload.sha256).toBe(
      createHash('sha256').update(payload.contents, 'utf8').digest('hex'),
    );
  });
});
