import { AGENT_PROTOCOL, type RawExcerpt } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { caseRecordSchema, storedCaseExecutionSchema } from '../record-schema.js';
import { parseRecord } from '../record-validation.js';

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
    const parsed = parseRecord(
      storedCaseExecutionSchema,
      executionWithExcerpt({ text: 'Par', truncated: true }),
      'execution',
    );

    expect(parsed).toEqual({
      ok: false,
      violations: [
        'execution.attempts[0].rawExcerpt a truncated excerpt must carry the sha256 of the full payload',
      ],
    });
    expect(
      parseRecord(
        storedCaseExecutionSchema,
        executionWithExcerpt({ text: 'Par', truncated: true, sha256: 'a'.repeat(64) }),
        'execution',
      ).ok,
    ).toBe(true);
  });

  it('reads a stored case written before cap-overflow excerpts carried a sha256', () => {
    const historical = executionWithExcerpt({ text: 'Par', truncated: true });
    const stored = { ...historical, rowId: 'row', runId: 'run', inputHash: 'hash', metrics: [] };

    expect(parseRecord(caseRecordSchema, stored, 'case').ok).toBe(true);
    expect(parseRecord(storedCaseExecutionSchema, historical, 'execution').ok).toBe(false);
    expect(
      parseRecord(
        caseRecordSchema,
        {
          ...stored,
          attempts: [
            { ...stored.attempts[0], rawExcerpt: { text: 'Par', truncated: true, sha256: 'A' } },
          ],
        },
        'case',
      ).ok,
    ).toBe(false);
  });
});

describe('stored response artifacts', () => {
  const artifact = {
    kind: 'inline',
    path: 'answer.ts',
    media_type: 'text/typescript',
    encoding: 'utf8',
    content: 'export const answer = 42;',
  };

  const parseWithArtifacts = (artifacts: unknown[]) =>
    parseRecord(
      caseRecordSchema,
      {
        ...executionWithExcerpt({ text: 'Paris', truncated: false }),
        response: { protocol: AGENT_PROTOCOL, output: 'Paris', artifacts },
        rowId: 'row',
        runId: 'run',
        inputHash: 'hash',
        metrics: [],
      },
      'case',
    );

  it('keeps inline artifacts and rejects references and unsafe paths', () => {
    expect(parseWithArtifacts([artifact])).toMatchObject({
      ok: true,
      value: { response: { artifacts: [artifact] } },
    });
    expect(parseWithArtifacts([{ kind: 'reference', path: 'answer.ts', id: 'blob-1' }]).ok).toBe(
      false,
    );
    expect(parseWithArtifacts([{ ...artifact, path: '../answer.ts' }]).ok).toBe(false);
  });
});
