import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type JudgeClient, type JudgeRecord } from '@attest/core';

import { loadConfig } from '../config/load-config.js';
import { runConfiguration } from './run-configuration.js';

const temporaryDirectories: string[] = [];

const createTestProject = async (): Promise<{ configPath: string; directory: string }> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-cli-run-'));
  temporaryDirectories.push(directory);
  const agentPath = join(directory, 'agent.mjs');
  const configPath = join(directory, 'attest.config.json');
  await writeFile(
    agentPath,
    [
      "let source = '';",
      "process.stdin.setEncoding('utf8');",
      'for await (const chunk of process.stdin) source += chunk;',
      'const request = JSON.parse(source);',
      "process.stdout.write(JSON.stringify({ protocol: 'attest.agent/v1alpha1', output: request.input }));",
      '',
    ].join('\n'),
  );
  await writeFile(
    configPath,
    JSON.stringify({
      config_version: 1,
      agent: { type: 'cli', command: [process.execPath, './agent.mjs'] },
      suites: [
        {
          name: 'smoke',
          metrics: ['answer'],
          cases: [{ id: 'capital', input: { answer: 'Paris' } }],
        },
      ],
      metrics: [
        {
          name: 'answer',
          type: 'assertion',
          assert: [{ equals: { path: '$.output.answer', value: 'Paris' } }],
        },
      ],
    }),
  );
  return { configPath, directory };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('runConfiguration', () => {
  it('runs agent to metric to SQLite and can diff a second run', async () => {
    const { configPath, directory } = await createTestProject();
    const loadedConfig = await loadConfig(configPath, directory);
    const first = await runConfiguration(loadedConfig);
    const second = await runConfiguration(loadedConfig, { baselineRunId: first.run.id });

    expect(first.run.summary).toEqual({
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      errorCases: 0,
      metricErrorCount: 0,
    });
    expect(first.cases[0]?.metrics[0]).toMatchObject({
      metricName: 'answer',
      status: 'evaluated',
      pass: true,
    });
    expect(second.diff?.summary.counts.still_passing).toBe(1);
  });

  it('validates a baseline before creating a candidate run', async () => {
    const { configPath, directory } = await createTestProject();
    const loadedConfig = await loadConfig(configPath, directory);

    await expect(
      runConfiguration(loadedConfig, { baselineRunId: 'missing-run' }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });

    const store = await openStore(join(directory, '.attest/runs.db'));
    try {
      await expect(store.runs.listRuns()).resolves.toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('wires judge metrics through the provider client and durable cache', async () => {
    const { configPath, directory } = await createTestProject();
    await writeFile(
      configPath,
      JSON.stringify({
        config_version: 1,
        agent: { type: 'cli', command: [process.execPath, './agent.mjs'] },
        suites: [
          {
            name: 'smoke',
            metrics: ['correctness'],
            cases: [{ id: 'capital', input: { answer: 'Paris' }, expected: { answer: 'Paris' } }],
          },
        ],
        metrics: [
          {
            name: 'correctness',
            type: 'judge',
            model: 'openai/test-model',
            rubric: 'Score one when output matches expected.',
            threshold: 0.8,
          },
        ],
      }),
    );
    const loadedConfig = await loadConfig(configPath, directory);
    let providerCalls = 0;
    const record: JudgeRecord = {
      request: {
        model: 'openai/test-model',
        system: 'system',
        user: 'user',
        params: { stream: false },
      },
      rawResponse: { score: 1, rationale: 'Matches.' },
      attempts: [{ rawResponse: { score: 1, rationale: 'Matches.' } }],
    };
    const judgeClient: JudgeClient = {
      scoreRubric: () => {
        providerCalls += 1;
        return Promise.resolve({ verdict: { score: 1, rationale: 'Matches.' }, record });
      },
    };

    const first = await runConfiguration(loadedConfig, { judgeClient });
    const second = await runConfiguration(loadedConfig, { judgeClient });

    expect(first.cases[0]?.metrics[0]).toMatchObject({
      metricName: 'correctness',
      status: 'evaluated',
      score: 1,
      pass: true,
      judgeIo: { cache: 'miss' },
    });
    expect(second.cases[0]?.metrics[0]).toMatchObject({
      metricName: 'correctness',
      status: 'evaluated',
      score: 1,
      pass: true,
      judgeIo: { cache: 'hit' },
    });
    expect(providerCalls).toBe(1);
  });
});
