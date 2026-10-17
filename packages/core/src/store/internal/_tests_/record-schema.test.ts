import { AGENT_PROTOCOL, type RawExcerpt } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { parseStoredCaseExecution } from '../record-validation.js';

const executionWithExcerpt = (rawExcerpt: RawExcerpt) => ({
  caseId: 'capital',
  suiteName: 'smoke',
  outcome: 'completed',
  request: {
    protocol: AGENT_PROTOCOL,
    run_id: '01JA0000000000000000000000',
    case_id: 'capital',
    input: 'Paris?',
  },
  response: { protocol: AGENT_PROTOCOL, output: 'Paris' },
  startedAt: '2026-10-17T00:00:00.000Z',
  durationMs: 1,
  warnings: [],
  diagnostics: {},
  attempts: [{ status: 'ok', diagnostics: {}, durationMs: 1, warnings: [], rawExcerpt }],
  expectedMetrics: [],
});

describe('stored attempt excerpts', () => {
  it('rejects a truncated excerpt that cannot identify the full payload', () => {
    const parsed = parseStoredCaseExecution(executionWithExcerpt({ text: 'Par', truncated: true }));

    expect(parsed).toEqual({
      ok: false,
      violations: [
        'execution.attempts[0].rawExcerpt a truncated excerpt must carry the sha256 of the full payload',
      ],
    });
    expect(
      parseStoredCaseExecution(
        executionWithExcerpt({ text: 'Par', truncated: true, sha256: 'a'.repeat(64) }),
      ).ok,
    ).toBe(true);
  });
});
