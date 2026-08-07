import {
  projectResourcesSchema,
  type AgentResource,
  type DatasetResource,
  type MetricResource,
  type ProjectManifest,
  type ProjectResources,
  type TestCase,
  type TestResource,
} from '@attest/contracts';

import {
  hashCanonicalJson,
  hashCanonicalJsonLines,
  serializeCanonicalJson,
  serializeCanonicalJsonLines,
  type JsonValue,
} from '../canonical-project.js';
import { ProjectTransactionError } from './project-transaction-error.js';

type CandidateFile = {
  canonicalHash: string;
  contents: string;
  path: string;
};

type PreparedProjectCandidate = {
  files: ReadonlyMap<string, CandidateFile>;
  project: ProjectResources;
  projectHash: string;
};

const sortById = <T extends { id: string }>(values: readonly T[]): T[] =>
  [...values].sort(({ id: left }, { id: right }) => left.localeCompare(right, 'en'));

/** Renders generated JSON with canonical key ordering and one terminal newline. */
const renderCanonicalJsonFile = (value: JsonValue): string =>
  `${JSON.stringify(JSON.parse(serializeCanonicalJson(value)), undefined, 2)}\n`;

/** Renders ordered JSONL records canonically, including a terminal newline when non-empty. */
const renderCanonicalJsonLinesFile = (values: readonly JsonValue[]): string => {
  const serialized = serializeCanonicalJsonLines(values);
  return serialized.length === 0 ? '' : `${serialized}\n`;
};

const addJsonResource = <T extends AgentResource | MetricResource | TestResource>(
  files: Map<string, CandidateFile>,
  path: string,
  resource: T,
): string => {
  const value = resource as JsonValue;
  const canonicalHash = hashCanonicalJson(value);
  files.set(path, {
    canonicalHash,
    contents: renderCanonicalJsonFile(value),
    path,
  });
  return canonicalHash;
};

const addDataset = (
  files: Map<string, CandidateFile>,
  metadata: DatasetResource,
  cases: readonly TestCase[],
): { dataHash: string; metadataHash: string } => {
  const metadataPath = `attest/datasets/${metadata.id}.meta.json`;
  const dataPath = `attest/datasets/${metadata.id}.jsonl`;
  const metadataValue = metadata as JsonValue;
  const caseValues = cases as unknown as readonly JsonValue[];
  const metadataHash = hashCanonicalJson(metadataValue);
  const dataHash = hashCanonicalJsonLines(caseValues);
  files.set(metadataPath, {
    canonicalHash: metadataHash,
    contents: renderCanonicalJsonFile(metadataValue),
    path: metadataPath,
  });
  files.set(dataPath, {
    canonicalHash: dataHash,
    contents: renderCanonicalJsonLinesFile(caseValues),
    path: dataPath,
  });
  return { dataHash, metadataHash };
};

/** Rebuilds a complete canonical project snapshot and validates every aggregate invariant. */
const prepareProjectCandidate = (candidate: ProjectResources): PreparedProjectCandidate => {
  const agents = sortById(candidate.agents);
  const tests = sortById(candidate.tests);
  const datasets = [...candidate.datasets].sort(({ metadata: left }, { metadata: right }) =>
    left.id.localeCompare(right.id, 'en'),
  );
  const metrics = sortById(candidate.metrics);
  const files = new Map<string, CandidateFile>();

  const agentEntries = agents.map((agent) => ({
    id: agent.id,
    schema: agent.schema,
    path: `attest/agents/${agent.id}.json`,
    content_hash: addJsonResource(files, `attest/agents/${agent.id}.json`, agent),
  }));
  const testEntries = tests.map((test) => ({
    id: test.id,
    schema: test.schema,
    path: `attest/tests/${test.id}.json`,
    content_hash: addJsonResource(files, `attest/tests/${test.id}.json`, test),
  }));
  const datasetEntries = datasets.map(({ cases, metadata }) => {
    const hashes = addDataset(files, metadata, cases);
    return {
      id: metadata.id,
      schema: metadata.schema,
      data_path: `attest/datasets/${metadata.id}.jsonl`,
      data_content_hash: hashes.dataHash,
      metadata_path: `attest/datasets/${metadata.id}.meta.json`,
      metadata_content_hash: hashes.metadataHash,
    };
  });
  const metricEntries = metrics.map((metric) => ({
    id: metric.id,
    schema: metric.schema,
    path: `attest/metrics/${metric.id}.json`,
    content_hash: addJsonResource(files, `attest/metrics/${metric.id}.json`, metric),
  }));

  const manifest: ProjectManifest = {
    schema: candidate.project.schema,
    project_id: candidate.project.project_id,
    name: candidate.project.name,
    ...(candidate.project.defaults === undefined ? {} : { defaults: candidate.project.defaults }),
    resources: {
      agents: agentEntries,
      tests: testEntries,
      datasets: datasetEntries,
      metrics: metricEntries,
    },
  };
  const project: ProjectResources = { agents, datasets, metrics, project: manifest, tests };
  const validated = projectResourcesSchema.safeParse(project);
  if (!validated.success) {
    throw new ProjectTransactionError(
      'candidate_invalid',
      `Candidate project validation failed with ${validated.error.issues.length} diagnostic(s).`,
      {
        diagnostics: validated.error.issues.map(({ message, path }) => ({
          message,
          path: path.length === 0 ? '' : `/${path.join('/')}`,
        })),
      },
    );
  }

  const manifestValue = validated.data.project as JsonValue;
  const projectHash = hashCanonicalJson(manifestValue);
  files.set('attest.project.json', {
    canonicalHash: projectHash,
    contents: renderCanonicalJsonFile(manifestValue),
    path: 'attest.project.json',
  });
  return { files, project: validated.data, projectHash };
};

export {
  prepareProjectCandidate,
  renderCanonicalJsonFile,
  renderCanonicalJsonLinesFile,
  type CandidateFile,
  type PreparedProjectCandidate,
};
