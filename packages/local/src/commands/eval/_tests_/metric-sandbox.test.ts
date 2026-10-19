import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { METRIC_RESOURCE_SCHEMA_ID, type MetricResource } from '@attest/contracts';
import { afterEach, expect, test } from 'vitest';

import { metricSandboxIsolation } from '../metric-sandbox.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const metric = (definition: MetricResource['definition']) => ({
  metric: {
    schema: METRIC_RESOURCE_SCHEMA_ID,
    id: 'm',
    name: 'm',
    definition,
  } satisfies MetricResource,
});

const context = (configuredIndex: number) => ({
  runId: 'run',
  testId: 'test',
  caseId: 'case',
  configuredIndex,
  workerIndex: 0,
  signal: new AbortController().signal,
});

test('boots a sandbox only for cases with an exec metric and seeds the scripts their argv names', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'attest-metric-sandbox-')));
  roots.push(base);
  const root = join(base, 'project');
  await mkdir(join(root, 'metrics'), { recursive: true });
  await writeFile(join(root, 'score.mjs'), 'score');
  await writeFile(join(root, 'metrics', 'check.py'), 'check');
  await writeFile(join(base, 'outside.mjs'), 'outside');

  const seeded: { path: string; content: string }[][] = [];

  const isolation = metricSandboxIsolation(
    root,
    [
      {
        configured_index: 0,
        metrics: [
          metric({ kind: 'judge', model: 'judge', rubric: 'Is it right?', threshold: 0.5 }),
        ],
      },
      {
        configured_index: 1,
        metrics: [
          metric({ kind: 'exec', argv: ['node', './score.mjs', '--strict'] }),
          metric({
            kind: 'exec',
            argv: ['python3', 'check.py', '../../outside.mjs'],
            cwd: 'metrics',
          }),
        ],
      },
    ],
    {
      credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
      sandboxFactory: () =>
        Promise.resolve({
          runCommand: () => Promise.resolve({ exitCode: 0 }),
          writeFiles: (files: { path: string; content: string }[]) => {
            seeded.push(files);

            return Promise.resolve();
          },
          readFile: () => Promise.reject(new Error('not used')),
          stop: () => Promise.resolve(),
        }),
    },
  );

  expect(await isolation(context(0))).toBeUndefined();

  const environment = await isolation(context(1));
  await environment?.dispose();

  expect(seeded).toEqual([
    [
      { path: '/vercel/sandbox/workspace/score.mjs', content: 'score' },
      { path: '/vercel/sandbox/workspace/check.py', content: 'check' },
    ],
  ]);
});
