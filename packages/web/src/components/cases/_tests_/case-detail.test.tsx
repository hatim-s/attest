// @vitest-environment happy-dom
import type { CaseRecord } from '@attest/core/records';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CaseDetail } from '../case-detail.js';

const runId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const answer = 'export const answer = 42;';

const caseRecord: CaseRecord = {
  rowId: 'row-one',
  runId,
  suiteName: 'smoke',
  caseId: 'one',
  inputHash: 'input',
  outcome: 'completed',
  startedAt: '2026-08-07T00:00:00.000Z',
  durationMs: 1,
  request: { protocol: 'attest.agent-invocation', run_id: runId, case_id: 'one', input: {} },
  response: {
    output: 'done',
    artifacts: [
      {
        kind: 'inline',
        path: 'answer.ts',
        media_type: 'text/typescript',
        encoding: 'utf8',
        content: answer,
      },
      {
        kind: 'inline',
        path: 'logo.png',
        media_type: 'image/png',
        encoding: 'base64',
        content: 'iVBORw0KGgo=',
      },
    ],
  },
  attempts: [],
  diagnostics: {},
  expectedMetrics: [],
  metrics: [],
  warnings: [],
};

it('lists response artifacts with their byte sizes and previews only the small utf8 file', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  root.render(
    <CaseDetail
      caseRecord={caseRecord}
      error={null}
      isLoading={false}
      onClose={vi.fn()}
      selected={{ suiteName: 'smoke', caseId: 'one' }}
    />,
  );

  try {
    const rows = await vi.waitFor(() => {
      const found = container.querySelectorAll('table[aria-label="Artifacts"] tbody tr');

      expect(found).toHaveLength(2);

      return found;
    });

    // 25 utf8 bytes; the base64 PNG signature decodes to 8 bytes.
    expect([...rows].map((row) => [...row.children].map((cell) => cell.textContent))).toEqual([
      ['answer.ts', 'text/typescript', '25'],
      ['logo.png', 'image/png', '8'],
    ]);
    // Only the utf8 file gets a preview; the base64 file shows its size alone.
    expect(
      [...container.querySelectorAll('details.artifact-preview pre')].map((pre) => pre.textContent),
    ).toEqual([answer]);
  } finally {
    root.unmount();
    container.remove();
  }
});
