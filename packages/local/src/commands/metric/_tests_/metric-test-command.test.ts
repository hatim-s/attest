import { renameSync, symlinkSync } from 'node:fs';
import { access, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMMAND_REQUEST_SCHEMA_ID,
  METRIC_RESOURCE_SCHEMA_ID,
  METRIC_TEST_FIXTURE_SCHEMA_ID,
  type MetricResource,
  type MetricTestFixture,
} from '@attest/contracts';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';

import { writeFixtureProject } from '../../../_tests_/support/project-transaction.js';
import { REDACTED } from '../../../internal/redaction.js';
import { runMetricMutationCommand } from '../metric-mutation-command.js';
import { runMetricTestCommand } from '../metric-test-command.js';

const EXEC_FIXTURE = fileURLToPath(new URL('./fixtures/result-metric.cjs', import.meta.url));

/** The child reports its sorted env keys; macOS adds `__CF_*` keys to every process. */
const envKeysSchema = z.object({
  details: z.object({ env_keys: z.array(z.string()) }),
});

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { force: true, recursive: true }));

  return directory;
};

const createProject = async (): Promise<string> => {
  const root = await temporaryDirectory('attest-metric-test-');
  await writeFixtureProject(root);

  return root;
};

const fixture = (answer: string, expectedPass: boolean): MetricTestFixture => ({
  schema: METRIC_TEST_FIXTURE_SCHEMA_ID,
  case: { id: 'local-case', input: { question: 'Capital?' }, expected: 'Paris' },
  expected_pass: expectedPass,
  output: { answer },
  trace: { schema: 'attest.trace', trace_id: 'trace-local', spans: [] },
});

const execMetric = (
  id: string,
  definition: Omit<Extract<MetricResource['definition'], { kind: 'exec' }>, 'kind'>,
): MetricResource => ({
  schema: METRIC_RESOURCE_SCHEMA_ID,
  id,
  name: id,
  definition: { kind: 'exec', ...definition },
});

const addMetric = (root: string, metric: MetricResource) =>
  runMetricMutationCommand({
    interactive: false,
    project: root,
    readStdin: () => Promise.reject(new Error('stdin must not be read')),
    request: { schema: COMMAND_REQUEST_SCHEMA_ID, command: 'metric.add', metric },
    workingDirectory: root,
  });

const testMetric = (root: string, metricId: string, document = fixture('Paris', true)) =>
  runMetricTestCommand({
    fixture: '-',
    metricId,
    project: root,
    readStdin: () => Promise.resolve(JSON.stringify(document)),
    workingDirectory: root,
  });

// BOUNDARY: The fixture metric process returns untrusted execution details; envKeysSchema validates the emitted key list.
const envKeys = (evaluation: unknown): string[] =>
  envKeysSchema.parse(evaluation).details.env_keys.filter((name) => !name.startsWith('__CF_'));

describe('runMetricTestCommand', () => {
  it('evaluates assertions deterministically and reports expected_pass mismatches', async () => {
    const root = await createProject();
    await addMetric(root, {
      schema: METRIC_RESOURCE_SCHEMA_ID,
      id: 'exact',
      name: 'Exact',
      definition: {
        kind: 'assertion',
        assertions: [{ equals: { path: '$.output.answer', value: 'Paris' } }],
      },
    });

    const first = await testMetric(root, 'exact');
    expect(await testMetric(root, 'exact')).toEqual(first);
    expect(first.result).toMatchObject({
      executed: true,
      expected_pass: true,
      evaluation: { status: 'evaluated', pass: true },
    });
    await expect(testMetric(root, 'exact', fixture('London', true))).rejects.toMatchObject({
      code: 'metric_fixture_mismatch',
      details: { actual_pass: false, expected_pass: true },
    });
    expect((await testMetric(root, 'exact', fixture('London', false))).result).toMatchObject({
      expected_pass: false,
      evaluation: { status: 'evaluated', pass: false },
    });
  });

  it('runs argv without a shell, redacts env secrets, and passes only the base environment', async () => {
    const root = await createProject();
    const marker = join(root, 'must-not-exist');
    vi.stubEnv('ATTEST_METRIC_SOURCE_SECRET', 'metric-super-secret');
    vi.stubEnv('ATTEST_METRIC_AMBIENT_SECRET', 'ambient-must-not-reach-child');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    await addMetric(
      root,
      execMetric('with-secret', {
        argv: [process.execPath, EXEC_FIXTURE, 'redact', ';', 'touch', marker],
        env: { METRIC_SECRET: { from_env: 'ATTEST_METRIC_SOURCE_SECRET' } },
      }),
    );
    await addMetric(
      root,
      execMetric('ambient', { argv: [process.execPath, EXEC_FIXTURE, 'ambient'] }),
    );

    const withSecret = await testMetric(root, 'with-secret');
    expect(JSON.stringify(withSecret)).not.toContain('metric-super-secret');
    expect(withSecret.result).toMatchObject({ evaluation: { rationale: REDACTED } });

    if (!withSecret.result.executed) throw new Error('Expected an executed metric.');
    expect(envKeys(withSecret.result.evaluation)).toEqual([
      'LC_ALL',
      'METRIC_SECRET',
      'PATH',
      'TMPDIR',
    ]);
    await expect(access(marker)).rejects.toThrow();

    const ambient = await testMetric(root, 'ambient');
    expect(ambient.result).toMatchObject({
      evaluation: { rationale: 'ambient-absent' },
    });

    if (!ambient.result.executed) throw new Error('Expected an executed metric.');
    expect(envKeys(ambient.result.evaluation)).toEqual(['LC_ALL', 'PATH', 'TMPDIR']);
  });

  it('reports a spawn failure as metric infrastructure failure', async () => {
    const root = await createProject();
    await addMetric(
      root,
      execMetric('broken', { argv: ['attest-metric-command-that-does-not-exist'] }),
    );
    await expect(testMetric(root, 'broken')).rejects.toMatchObject({
      code: 'metric_infrastructure_failed',
      details: { evaluation: { status: 'error', error: { kind: 'exec_spawn_failed' } } },
    });
  });

  it('rejects an executable cwd symlink that escapes the project', async () => {
    const root = await createProject();
    const outside = await temporaryDirectory('attest-metric-cwd-outside-');
    await symlink(outside, join(root, 'linkout'));
    await addMetric(
      root,
      execMetric('escaped-cwd', { argv: [process.execPath, EXEC_FIXTURE], cwd: 'linkout' }),
    );
    await expect(testMetric(root, 'escaped-cwd')).rejects.toMatchObject({
      code: 'project_invalid',
      message: 'Metric cwd is not a safe project directory.',
    });
  });

  it('rejects a cwd swapped for an outside symlink while metric secrets resolve', async () => {
    const root = await createProject();
    const outside = await temporaryDirectory('attest-metric-cwd-race-');
    const cwd = join(root, 'metric-cwd');
    await mkdir(cwd);
    await addMetric(
      root,
      execMetric('race', {
        argv: [process.execPath, '-e', "require('node:fs').writeFileSync('spawned.txt', 'x')"],
        cwd: 'metric-cwd',
        env: { RACE: { from_env: 'ATTEST_METRIC_RACE_SECRET' } },
      }),
    );

    // Swaps the cwd for an outside symlink at the moment the metric secret is read, which is
    // after the cwd was checked and before the metric process spawns.
    const environment = process.env;
    let swapped = false;
    process.env = new Proxy(environment, {
      get: (target, key) => {
        if (key !== 'ATTEST_METRIC_RACE_SECRET') return target[String(key)];

        if (!swapped) {
          swapped = true;
          renameSync(cwd, `${cwd}-saved`);
          symlinkSync(outside, cwd);
        }

        return 'race-secret';
      },
    });
    onTestFinished(() => {
      process.env = environment;
    });

    await expect(testMetric(root, 'race')).rejects.toMatchObject({ code: 'project_invalid' });
    expect(swapped).toBe(true);
    await expect(access(join(outside, 'spawned.txt'))).rejects.toThrow();
  });
});
