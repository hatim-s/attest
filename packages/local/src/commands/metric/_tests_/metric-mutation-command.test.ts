import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMMAND_REQUEST_SCHEMA_ID,
  METRIC_RESOURCE_SCHEMA_ID,
  type MetricResource,
} from '@attest/contracts';
import { describe, expect, it, onTestFinished } from 'vitest';

import { writeFixtureProject } from '../../../_tests_/support/project-transaction.js';
import { loadProject } from '../../../project/project-loader/index.js';
import { applyProjectMutation } from '../../../project/transaction/index.js';
import { candidateFromLoadedProject } from '../../project/load-command-project.js';
import { createMetricResource } from '../authoring/index.js';
import {
  runMetricMutationCommand,
  type MetricAuthoringRequest,
} from '../metric-mutation-command.js';

const createProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'attest-metric-mutation-'));
  onTestFinished(() => rm(root, { force: true, recursive: true }));
  await writeFixtureProject(root);
  return root;
};

const schema = COMMAND_REQUEST_SCHEMA_ID;

const mutate = (root: string, request: MetricAuthoringRequest, stdin = '') =>
  runMetricMutationCommand({
    interactive: false,
    project: root,
    readStdin: () => Promise.resolve(stdin),
    request,
    workingDirectory: root,
  });

/** Resolves to the rejection reason, or undefined when the mutation succeeds. */
const rejection = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (error: unknown) => error,
  );

const snapshotFiles = async (root: string): Promise<Record<string, string>> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const contents = await Promise.all(
    files.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);
      return [path, await readFile(path, 'utf8')] as const;
    }),
  );
  return Object.fromEntries(contents);
};

describe('runMetricMutationCommand', () => {
  it('renames every reference and removes a referenced metric only with detach', async () => {
    const root = await createProject();
    const loaded = await loadProject({ project: root });
    const candidate = candidateFromLoadedProject(loaded);
    candidate.tests[0]!.cases.push({
      id: 'direct',
      input: {},
      metric_overrides: [{ metric_id: 'correct', threshold: 0.75 }],
    });
    candidate.datasets[0]!.cases[0]!.metric_overrides = [{ metric_id: 'correct' }];
    await applyProjectMutation({
      candidate,
      expectedProjectHash: loaded.projectHash,
      projectRoot: root,
    });

    await expect(
      mutate(root, { schema, command: 'metric.remove', metric_id: 'correct', yes: true }),
    ).rejects.toMatchObject({
      code: 'project_invalid',
      details: {
        reference_paths: [
          '/datasets/refunds/cases/0/metric_overrides/0',
          '/tests/refund/cases/0/metric_overrides/0',
          '/tests/refund/metrics/0',
        ],
      },
    });

    await mutate(root, {
      schema,
      command: 'metric.rename',
      metric_id: 'correct',
      new_id: 'correctness',
    });
    const renamed = await loadProject({ project: root });
    expect(renamed.tests[0]?.metrics[0]?.metric_id).toBe('correctness');
    expect(renamed.tests[0]?.cases[0]?.metric_overrides?.[0]?.metric_id).toBe('correctness');
    expect(renamed.datasets[0]?.cases[0]?.metric_overrides?.[0]?.metric_id).toBe('correctness');

    const removed = await mutate(root, {
      schema,
      command: 'metric.remove',
      metric_id: 'correctness',
      detach: true,
      yes: true,
    });
    expect(removed.warnings).toEqual([
      {
        code: 'metric_references_detached',
        message: 'Detached 3 metric references before removal.',
      },
    ]);
    const detached = await loadProject({ project: root });
    expect(detached.metrics).toEqual([]);
    expect(detached.tests[0]?.metrics).toEqual([]);
    expect(detached.tests[0]?.cases[0]?.metric_overrides).toEqual([]);
    expect(detached.datasets[0]?.cases[0]?.metric_overrides).toEqual([]);
  });

  it('rejects credential literals from flags, imports, and requests without echoing them', async () => {
    const root = await createProject();
    const before = await snapshotFiles(root);
    const secrets = ['literal-access-secret', 'literal-api-secret', 'literal-exec-secret'] as const;
    const unsafeHttp: MetricResource = {
      schema: METRIC_RESOURCE_SCHEMA_ID,
      id: 'unsafe-http',
      name: 'Unsafe HTTP',
      definition: {
        kind: 'http',
        request: {
          method: 'POST',
          url: 'https://metric.example/evaluate',
          body: { nested: { apiKey: secrets[1] } },
        },
        extraction: { score_pointer: '/score', pass_pointer: '/pass' },
      },
    };
    const unsafeExec: MetricResource = {
      schema: METRIC_RESOURCE_SCHEMA_ID,
      id: 'exec-secret',
      name: 'Exec secret',
      definition: { kind: 'exec', argv: ['metric', '--api-key', secrets[2]] },
    };

    const errors = [
      await rejection(
        createMetricResource({
          metricId: 'flag-secret',
          preset: 'http',
          url: 'https://metric.example/evaluate',
          bodyJson: JSON.stringify({ accessToken: secrets[0] }),
          readStdin: () => Promise.resolve(''),
          workingDirectory: root,
        }),
      ),
      await rejection(
        mutate(
          root,
          {
            schema,
            command: 'metric.import',
            source: '-',
            source_type: 'json',
            as: 'import-secret',
          },
          JSON.stringify(unsafeHttp),
        ),
      ),
      await rejection(mutate(root, { schema, command: 'metric.add', metric: unsafeExec })),
    ];
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'project_invalid',
        path: '/metric/definition/request/body/accessToken',
      }),
      expect.objectContaining({
        code: 'project_invalid',
        path: '/metric/definition/request/body/nested/apiKey',
      }),
      expect.objectContaining({ code: 'project_invalid', path: '/metric/definition/argv/2' }),
    ]);
    const serialized = errors.map((error) => `${String(error)} ${JSON.stringify(error)}`).join();
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(await snapshotFiles(root)).toEqual(before);
  });

  it('builds executable and HTTP metrics with secret references from flag fields', async () => {
    const fields = { readStdin: () => Promise.resolve(''), workingDirectory: tmpdir() };
    const exec = await createMetricResource({
      ...fields,
      metricId: 'exec',
      preset: 'command',
      argvJson: JSON.stringify(['metric']),
      env: ['METRIC_SECRET=ATTEST_METRIC_SOURCE_SECRET'],
      timeout: '5s',
    });
    expect(exec.definition).toEqual({
      kind: 'exec',
      argv: ['metric'],
      env: { METRIC_SECRET: { from_env: 'ATTEST_METRIC_SOURCE_SECRET' } },
      timeout_ms: 5_000,
    });
    const http = await createMetricResource({
      ...fields,
      metricId: 'http',
      preset: 'http',
      url: 'https://metric.example/evaluate',
      headerEnv: ['Authorization=ATTEST_METRIC_SOURCE_SECRET'],
      scorePointer: '/verdict/score',
      passPointer: '/verdict/pass',
    });
    expect(http.definition).toMatchObject({
      kind: 'http',
      request: { headers: { Authorization: { from_env: 'ATTEST_METRIC_SOURCE_SECRET' } } },
      extraction: { score_pointer: '/verdict/score', pass_pointer: '/verdict/pass' },
    });
  });
});
