import {
  agentResourceSchema,
  metricResourceSchema,
  projectManifestSchema,
  projectResourcesSchema,
  testResourceSchema,
  type AgentResource,
  type MetricResource,
  type TestResource,
} from '@attest/contracts';

import { hashProjectManifest } from '../canonical-project.js';
import {
  PROJECT_MANIFEST_FILE,
  discoverProject,
  type DiscoverProjectOptions,
} from '../discover-project.js';
import { ProjectLoadError } from '../project-errors.js';
import { loadDataset } from './dataset-loader.js';
import { loadJsonResource, toJsonPointer } from './source-loader.js';
import type {
  LoadedDatasetResource,
  LoadedJsonResource,
  LoadedProject,
  ProjectContentHashes,
} from './types.js';

const sourceForProjectIssue = (
  path: readonly PropertyKey[],
  sources: {
    agents: readonly string[];
    datasets: readonly { data: string; metadata: string }[];
    metrics: readonly string[];
    tests: readonly string[];
  },
): { path: PropertyKey[]; source: string } => {
  const [collection, rawIndex, field, ...remaining] = path;
  if (collection === 'project') return { path: path.slice(1), source: PROJECT_MANIFEST_FILE };
  const index = typeof rawIndex === 'number' ? rawIndex : -1;
  if (collection === 'datasets') {
    const datasetSource = sources.datasets[index];
    const useMetadata = field === 'metadata';
    return {
      path: useMetadata ? remaining : field === undefined ? remaining : [field, ...remaining],
      source:
        datasetSource === undefined
          ? PROJECT_MANIFEST_FILE
          : useMetadata
            ? datasetSource.metadata
            : datasetSource.data,
    };
  }
  const collectionSources =
    collection === 'agents'
      ? sources.agents
      : collection === 'tests'
        ? sources.tests
        : collection === 'metrics'
          ? sources.metrics
          : undefined;
  return {
    path: field === undefined ? remaining : [field, ...remaining],
    source: collectionSources?.[index] ?? PROJECT_MANIFEST_FILE,
  };
};

/** Loads the complete project read model and rejects aggregate source-safe diagnostics. */
const loadProject = async (options: DiscoverProjectOptions = {}): Promise<LoadedProject> => {
  const discovered = await discoverProject(options);
  const manifest = await loadJsonResource(
    discovered.root,
    PROJECT_MANIFEST_FILE,
    undefined,
    projectManifestSchema,
  );
  if (manifest.value === undefined || manifest.hash === undefined) {
    throw new ProjectLoadError(
      'project_invalid',
      `Project manifest validation failed with ${manifest.diagnostics.length} diagnostic(s).`,
      manifest.diagnostics,
    );
  }

  const agentLoads: LoadedJsonResource<AgentResource>[] = [];
  for (const entry of manifest.value.resources.agents) {
    agentLoads.push(
      await loadJsonResource(discovered.root, entry.path, entry.content_hash, agentResourceSchema),
    );
  }
  const testLoads: LoadedJsonResource<TestResource>[] = [];
  for (const entry of manifest.value.resources.tests) {
    testLoads.push(
      await loadJsonResource(discovered.root, entry.path, entry.content_hash, testResourceSchema),
    );
  }
  const datasetLoads: LoadedDatasetResource[] = [];
  for (const entry of manifest.value.resources.datasets) {
    datasetLoads.push(await loadDataset(discovered.root, entry));
  }
  const metricLoads: LoadedJsonResource<MetricResource>[] = [];
  for (const entry of manifest.value.resources.metrics) {
    metricLoads.push(
      await loadJsonResource(discovered.root, entry.path, entry.content_hash, metricResourceSchema),
    );
  }

  const diagnostics = [
    ...agentLoads.flatMap(({ diagnostics: issues }) => issues),
    ...testLoads.flatMap(({ diagnostics: issues }) => issues),
    ...datasetLoads.flatMap(({ diagnostics: issues }) => issues),
    ...metricLoads.flatMap(({ diagnostics: issues }) => issues),
  ];
  const agents = agentLoads.flatMap(({ value }) => (value === undefined ? [] : [value]));
  const tests = testLoads.flatMap(({ value }) => (value === undefined ? [] : [value]));
  const datasets = datasetLoads.flatMap(({ value }) => (value === undefined ? [] : [value]));
  const metrics = metricLoads.flatMap(({ value }) => (value === undefined ? [] : [value]));
  const sources = {
    agents: agentLoads.flatMap(({ source, value }) => (value === undefined ? [] : [source])),
    datasets: datasetLoads.flatMap(({ source, value }) => (value === undefined ? [] : [source])),
    metrics: metricLoads.flatMap(({ source, value }) => (value === undefined ? [] : [source])),
    tests: testLoads.flatMap(({ source, value }) => (value === undefined ? [] : [source])),
  };
  const validated = projectResourcesSchema.safeParse({
    agents,
    datasets,
    metrics,
    project: manifest.value,
    tests,
  });
  if (!validated.success) {
    diagnostics.push(
      ...validated.error.issues.map((issue) => {
        const source = sourceForProjectIssue(issue.path, sources);
        return {
          code: 'schema_invalid' as const,
          message: issue.message,
          path: toJsonPointer(source.path),
          source: source.source,
        };
      }),
    );
  }
  if (diagnostics.length > 0 || !validated.success) {
    throw new ProjectLoadError(
      'project_invalid',
      `Project validation failed with ${diagnostics.length} diagnostic(s).`,
      diagnostics,
    );
  }

  const contentHashes: ProjectContentHashes = {
    agents: Object.fromEntries(agentLoads.map((loaded) => [loaded.value!.id, loaded.hash!])),
    datasets: Object.fromEntries(
      datasetLoads.map((loaded) => [
        loaded.value!.metadata.id,
        { data: loaded.dataHash!, metadata: loaded.metadataHash! },
      ]),
    ),
    manifest: manifest.hash,
    metrics: Object.fromEntries(metricLoads.map((loaded) => [loaded.value!.id, loaded.hash!])),
    tests: Object.fromEntries(testLoads.map((loaded) => [loaded.value!.id, loaded.hash!])),
  };

  return {
    ...validated.data,
    contentHashes,
    manifestPath: discovered.manifestPath,
    // Integrity hashes bind every persisted byte; the project projection excludes import time.
    projectHash: hashProjectManifest(
      validated.data.project,
      validated.data.datasets.map(({ metadata }) => metadata),
    ),
    root: discovered.root,
  };
};

export { loadProject };
