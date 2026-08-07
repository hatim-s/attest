import { mkdir, writeFile } from 'node:fs/promises';
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
  type ProjectResources,
  type TestCase,
  type TestResource,
} from '@attest/contracts';

import { hashCanonicalJson, hashCanonicalJsonLines } from '../canonical-project.js';
import type { LoadedProject } from '../load-project.js';

const fixtureAgent: AgentResource = {
  schema: AGENT_RESOURCE_SCHEMA_VERSION,
  id: 'support',
  name: 'Support',
  transport: {
    kind: 'native_cli',
    lifecycle: 'per_case',
    argv: ['node', './src/agent.mjs'],
  },
};
const fixtureMetric: MetricResource = {
  schema: METRIC_RESOURCE_SCHEMA_VERSION,
  id: 'correct',
  name: 'Correct',
  definition: {
    kind: 'assertion',
    assertions: [{ contains: { path: '$.output', value: 'expected' } }],
  },
};
const fixtureCase: TestCase = {
  id: 'refund-basic',
  input: { question: 'How do refunds work?' },
  expected: 'expected',
};
const fixtureDataset: DatasetResource = {
  schema: DATASET_SCHEMA_VERSION,
  case_schema: CASE_SCHEMA_VERSION,
  id: 'refunds',
  name: 'Refunds',
  case_count: 1,
};
const fixtureTest: TestResource = {
  schema: TEST_RESOURCE_SCHEMA_VERSION,
  id: 'refund',
  name: 'Refund',
  agent_id: fixtureAgent.id,
  cases: [],
  datasets: [{ dataset_id: fixtureDataset.id }],
  metrics: [{ metric_id: fixtureMetric.id }],
};

/** Writes one complete valid project used by transaction integration tests. */
const writeFixtureProject = async (root: string): Promise<void> => {
  const files = new Map<string, string>([
    ['attest/agents/support.json', JSON.stringify(fixtureAgent, undefined, 2)],
    ['attest/tests/refund.json', JSON.stringify(fixtureTest, undefined, 2)],
    ['attest/datasets/refunds.meta.json', JSON.stringify(fixtureDataset, undefined, 2)],
    ['attest/datasets/refunds.jsonl', JSON.stringify(fixtureCase)],
    ['attest/metrics/correct.json', JSON.stringify(fixtureMetric, undefined, 2)],
  ]);
  const manifest: ProjectManifest = {
    schema: PROJECT_SCHEMA_VERSION,
    project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    name: 'support',
    resources: {
      agents: [
        {
          id: fixtureAgent.id,
          schema: fixtureAgent.schema,
          path: 'attest/agents/support.json',
          content_hash: hashCanonicalJson(fixtureAgent),
        },
      ],
      tests: [
        {
          id: fixtureTest.id,
          schema: fixtureTest.schema,
          path: 'attest/tests/refund.json',
          content_hash: hashCanonicalJson(fixtureTest),
        },
      ],
      datasets: [
        {
          id: fixtureDataset.id,
          schema: fixtureDataset.schema,
          data_path: 'attest/datasets/refunds.jsonl',
          data_content_hash: hashCanonicalJsonLines([fixtureCase]),
          metadata_path: 'attest/datasets/refunds.meta.json',
          metadata_content_hash: hashCanonicalJson(fixtureDataset),
        },
      ],
      metrics: [
        {
          id: fixtureMetric.id,
          schema: fixtureMetric.schema,
          path: 'attest/metrics/correct.json',
          content_hash: hashCanonicalJson(fixtureMetric),
        },
      ],
    },
  };
  files.set('attest.project.json', JSON.stringify(manifest, undefined, 2));
  for (const [path, contents] of files) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `${contents}\n`);
  }
};

/** Removes loader-only metadata to create a mutable candidate snapshot. */
const candidateFromLoadedProject = (loaded: LoadedProject): ProjectResources =>
  structuredClone({
    agents: loaded.agents,
    datasets: loaded.datasets,
    metrics: loaded.metrics,
    project: loaded.project,
    tests: loaded.tests,
  });

export {
  candidateFromLoadedProject,
  fixtureAgent,
  fixtureCase,
  fixtureDataset,
  fixtureMetric,
  fixtureTest,
  writeFixtureProject,
};
