import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_PROTOCOL } from '@attest/contracts';
import { openStore } from '@attest/core';
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_REPORT_CASES, runReportCommand, selectReportCases } from './run-report-command.js';

const directories: string[] = [];

/** Creates one persisted run whose payload exercises inline-script escaping. */
const createRunFixture = async (directory: string): Promise<string> => {
  await mkdir(join(directory, '.attest'), { recursive: true });
  const store = await openStore(join(directory, '.attest', 'runs.db'));
  try {
    const run = await store.runs.createRun({
      configVersion: '1',
      configHash: 'sha256:test',
      configJson: '{}',
    });
    await store.runs.recordCase(
      run.id,
      {
        attempts: [],
        caseId: 'inline-script',
        diagnostics: {},
        durationMs: 4,
        expectedMetrics: ['safe'],
        outcome: 'completed',
        request: {
          protocol: AGENT_PROTOCOL,
          run_id: run.id,
          case_id: 'inline-script',
          input: '</script><script>bad()</script>',
        },
        response: { protocol: AGENT_PROTOCOL, output: 'safe' },
        startedAt: '2026-08-07T00:00:00.000Z',
        suiteName: 'report',
        warnings: [],
      },
      [{ kind: 'assertion', metricName: 'safe', pass: true, score: 1, status: 'evaluated' }],
    );
    await store.runs.finalizeRun(run.id, 'completed');
    return run.id;
  } finally {
    await store.close();
  }
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('runReportCommand', () => {
  it('caps oversized report evidence at ten thousand cases', () => {
    const allCases = Array.from({ length: MAX_REPORT_CASES + 1 }, (_, index) => index);

    expect(selectReportCases(allCases)).toMatchObject({
      cases: { length: MAX_REPORT_CASES },
      truncated: true,
    });
  });

  it('writes a self-contained report and refuses overwrite without force', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-report-command-'));
    directories.push(directory);
    const runId = await createRunFixture(directory);
    const outputPath = 'reports/run.html';

    const result = await runReportCommand({
      outputPath,
      runId,
      workingDirectory: directory,
    });
    const html = await readFile(result.outputPath, 'utf8');

    expect(result).toMatchObject({ caseCount: 1, totalCaseCount: 1, truncated: false });
    expect(html).toContain('window.__ATTEST_REPORT__=');
    expect(html).toContain('\\u003c/script>');
    await expect(
      runReportCommand({ outputPath, runId, workingDirectory: directory }),
    ).rejects.toMatchObject({ code: 'output_exists' });
    await expect(
      runReportCommand({ force: true, outputPath, runId, workingDirectory: directory }),
    ).resolves.toMatchObject({ caseCount: 1 });
  });
});
