import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  AGENT_RESOURCE_SCHEMA_VERSION,
  CASE_SCHEMA_VERSION,
  DATASET_SCHEMA_VERSION,
  METRIC_RESOURCE_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
  TEST_RESOURCE_SCHEMA_VERSION,
  type AgentResource,
  type DatasetResource,
  type MetricResource,
  type ProjectManifest,
  type TestCase,
  type TestResource,
} from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { hashCanonicalJson, hashCanonicalJsonLines } from './canonical-project.js';
import { loadProject } from './load-project.js';
import { ProjectLoadError } from './project-errors.js';

const temporaryDirectories: string[] = [];

const agent: AgentResource = {
  schema: AGENT_RESOURCE_SCHEMA_VERSION,
  id: 'support',
  name: 'Support',
  transport: {
    kind: 'native_cli',
    lifecycle: 'per_case',
    argv: ['node', './src/agent.mjs'],
  },
};
const metric: MetricResource = {
  schema: METRIC_RESOURCE_SCHEMA_VERSION,
  id: 'correct',
  name: 'Correct',
  definition: {
    kind: 'assertion',
    assertions: [{ contains: { path: '$.output', value: 'expected' } }],
  },
};
const testCase: TestCase = {
  id: 'refund-basic',
  input: { question: 'How do refunds work?' },
  expected: 'expected',
};
const dataset: DatasetResource = {
  schema: DATASET_SCHEMA_VERSION,
  case_schema: CASE_SCHEMA_VERSION,
  id: 'refunds',
  name: 'Refunds',
  case_count: 1,
};
const test: TestResource = {
  schema: TEST_RESOURCE_SCHEMA_VERSION,
  id: 'refund',
  name: 'Refund',
  agent_id: agent.id,
  cases: [],
  datasets: [{ dataset_id: dataset.id }],
  metrics: [{ metric_id: metric.id }],
};

/** Creates and tracks an isolated project root for loader integration tests. */
const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-project-loader-'));
  temporaryDirectories.push(directory);
  return directory;
};

/** Writes one file after creating its canonical project directory. */
const writeProjectFile = async (root: string, path: string, contents: string): Promise<void> => {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
};

/** Writes a complete valid v2 project and returns its generated manifest. */
const writeValidProject = async (
  root: string,
  formatting: 'compact' | 'pretty' = 'compact',
): Promise<ProjectManifest> => {
  const render = (value: unknown): string =>
    formatting === 'pretty' ? JSON.stringify(value, undefined, 2) : JSON.stringify(value);
  const dataRecords = [testCase];
  await writeProjectFile(root, 'attest/agents/support.json', render(agent));
  await writeProjectFile(root, 'attest/tests/refund.json', render(test));
  await writeProjectFile(root, 'attest/datasets/refunds.meta.json', render(dataset));
  await writeProjectFile(
    root,
    'attest/datasets/refunds.jsonl',
    formatting === 'pretty' ? `  ${JSON.stringify(testCase)}  \r\n\r\n` : JSON.stringify(testCase),
  );
  await writeProjectFile(root, 'attest/metrics/correct.json', render(metric));

  const manifest: ProjectManifest = {
    schema: PROJECT_SCHEMA_VERSION,
    project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    name: 'support',
    resources: {
      agents: [
        {
          id: agent.id,
          schema: AGENT_RESOURCE_SCHEMA_VERSION,
          path: 'attest/agents/support.json',
          content_hash: hashCanonicalJson(agent),
        },
      ],
      tests: [
        {
          id: test.id,
          schema: TEST_RESOURCE_SCHEMA_VERSION,
          path: 'attest/tests/refund.json',
          content_hash: hashCanonicalJson(test),
        },
      ],
      datasets: [
        {
          id: dataset.id,
          schema: DATASET_SCHEMA_VERSION,
          data_path: 'attest/datasets/refunds.jsonl',
          data_content_hash: hashCanonicalJsonLines(dataRecords),
          metadata_path: 'attest/datasets/refunds.meta.json',
          metadata_content_hash: hashCanonicalJson(dataset),
        },
      ],
      metrics: [
        {
          id: metric.id,
          schema: METRIC_RESOURCE_SCHEMA_VERSION,
          path: 'attest/metrics/correct.json',
          content_hash: hashCanonicalJson(metric),
        },
      ],
    },
  };
  await writeProjectFile(root, 'attest.project.json', render(manifest));
  return manifest;
};

/** Captures the typed aggregate error produced by a failing project load. */
const captureProjectFailure = async (
  operation: () => Promise<unknown>,
): Promise<ProjectLoadError> => {
  try {
    await operation();
  } catch (error: unknown) {
    if (error instanceof ProjectLoadError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected project loading to fail.');
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('loadProject', () => {
  it('loads JSONL datasets and keeps project hashes stable across paths and formatting', async () => {
    const compactRoot = await createTemporaryDirectory();
    const prettyRoot = await createTemporaryDirectory();
    await writeValidProject(compactRoot);
    await writeValidProject(prettyRoot, 'pretty');
    const nested = join(compactRoot, 'src', 'nested');
    await mkdir(nested, { recursive: true });

    const compact = await loadProject({ workingDirectory: nested });
    const pretty = await loadProject({ project: prettyRoot });

    expect(compact.datasets[0]?.cases).toEqual([testCase]);
    expect(compact.contentHashes.datasets.refunds).toEqual({
      data: hashCanonicalJsonLines([testCase]),
      metadata: hashCanonicalJson(dataset),
    });
    expect(compact.projectHash).toBe(pretty.projectHash);
    expect(compact.projectHash).toHaveLength(64);
  });

  it('aggregates malformed, missing, duplicate, and reference failures by source', async () => {
    const root = await createTemporaryDirectory();
    const manifest = await writeValidProject(root);
    const invalidTest: TestResource = {
      ...test,
      agent_id: 'missing-agent',
      cases: [testCase, testCase],
      metrics: [
        { metric_id: 'correct' },
        { metric_id: 'correct' },
        { metric_id: 'missing-metric' },
      ],
    };
    await writeProjectFile(root, 'attest/agents/support.json', '{"token":"DO-NOT-LEAK"');
    await writeProjectFile(root, 'attest/tests/refund.json', JSON.stringify(invalidTest));
    await unlink(join(root, 'attest/metrics/correct.json'));
    manifest.resources.tests[0]!.content_hash = hashCanonicalJson(invalidTest);
    await writeProjectFile(root, 'attest.project.json', JSON.stringify(manifest));

    let failure: unknown;
    try {
      await loadProject({ project: root });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ProjectLoadError);
    expect(failure).toMatchObject({ code: 'project_invalid' });
    const diagnostics = (failure as ProjectLoadError).diagnostics;
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'json_invalid', source: 'attest/agents/support.json' }),
        expect.objectContaining({ code: 'source_missing', source: 'attest/metrics/correct.json' }),
        expect.objectContaining({ message: 'agent is not defined: missing-agent' }),
        expect.objectContaining({ message: 'duplicate resolved case id: refund-basic' }),
        expect.objectContaining({ message: 'duplicate metric reference: correct' }),
        expect.objectContaining({ message: 'metric is not defined: missing-metric' }),
      ]),
    );
    expect((failure as Error).message).not.toContain('DO-NOT-LEAK');
  });

  it('rejects a v1-shaped manifest with the stable breaking-v2 diagnostic', async () => {
    const root = await createTemporaryDirectory();
    await writeProjectFile(
      root,
      'attest.project.json',
      JSON.stringify({ config_version: 1, agent: {}, suites: [], metrics: [] }),
    );

    const failure = await captureProjectFailure(() => loadProject({ project: root }));

    expect(failure).toMatchObject({
      code: 'project_invalid',
      message: 'Attest v2 does not execute v1 configuration or project inputs.',
      hint: 'Create a v2 project with `attest project init`; use `attest eval run` as the only execution command.',
      path: 'attest.project.json',
    });
    expect(failure.diagnostics).toEqual([
      expect.objectContaining({ code: 'legacy_v1', source: 'attest.project.json' }),
    ]);
  });

  it('rejects manifest traversal before reading outside the project', async () => {
    const root = await createTemporaryDirectory();
    const manifest = await writeValidProject(root);
    manifest.resources.agents[0]!.path = '../outside.json';
    await writeProjectFile(root, 'attest.project.json', JSON.stringify(manifest));

    const failure = await captureProjectFailure(() => loadProject({ project: root }));

    expect(failure.code).toBe('project_invalid');
    expect(failure.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'attest.project.json', code: 'schema_invalid' }),
      ]),
    );
  });

  it('rejects canonical resource symlinks that escape the project root', async () => {
    const root = await createTemporaryDirectory();
    const outside = await createTemporaryDirectory();
    await writeValidProject(root);
    const agentPath = join(root, 'attest/agents/support.json');
    const outsidePath = join(outside, 'agent.json');
    await writeFile(outsidePath, JSON.stringify(agent));
    await unlink(agentPath);
    await symlink(outsidePath, agentPath);

    const failure = await captureProjectFailure(() => loadProject({ project: root }));

    expect(failure.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'path_unsafe', source: 'attest/agents/support.json' }),
      ]),
    );
  });

  it('reports malformed and invalid JSONL rows with physical line context', async () => {
    const root = await createTemporaryDirectory();
    const manifest = await writeValidProject(root);
    await writeProjectFile(
      root,
      'attest/datasets/refunds.jsonl',
      `${JSON.stringify(testCase)}\n{"token":"DATASET-SECRET"\n{"id":"INVALID ID","input":"x"}\n`,
    );

    let failure: unknown;
    try {
      await loadProject({ project: root });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ProjectLoadError);
    expect((failure as ProjectLoadError).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'json_invalid',
          path: 'line 2',
          source: 'attest/datasets/refunds.jsonl',
        }),
        expect.objectContaining({
          code: 'schema_invalid',
          path: '/line 3/id',
          source: 'attest/datasets/refunds.jsonl',
        }),
      ]),
    );
    expect((failure as Error).message).not.toContain('DATASET-SECRET');
    expect(manifest.resources.datasets[0]!.data_content_hash).toHaveLength(64);
  });

  it('rejects stale canonical content hashes', async () => {
    const root = await createTemporaryDirectory();
    await writeValidProject(root);
    await writeProjectFile(
      root,
      'attest/metrics/correct.json',
      JSON.stringify({ ...metric, name: 'Changed' }),
    );

    const failure = await captureProjectFailure(() => loadProject({ project: root }));

    expect(failure.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'content_hash_mismatch',
          source: 'attest/metrics/correct.json',
        }),
      ]),
    );
  });
});
