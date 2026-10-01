import {
  agentResourceSchema,
  metricResourceSchema,
  projectManifestSchema,
  projectResourcesSchema,
  testResourceSchema,
} from '@attest/contracts';
import type { z } from 'zod';

import { hashProjectManifest } from '../canonical-project.js';
import {
  PROJECT_MANIFEST_FILE,
  discoverProject,
  type DiscoverProjectOptions,
} from '../discover-project.js';
import { ProjectLoadError } from '../project-errors.js';
import { loadDataset } from './dataset-loader.js';
import { toJsonPointer } from '../../internal/json-pointer.js';
import { loadJsonResource } from './source-loader.js';
import type {
  LoadedDatasetResource,
  LoadedJsonResource,
  LoadedProject,
  ProjectContentHashes,
} from './types.js';

type ResourceSources = {
  agents: readonly string[];
  datasets: readonly { data: string; metadata: string }[];
  metrics: readonly string[];
  tests: readonly string[];
};

/** Maps an aggregate schema issue path back to the authored file that holds the bad value. */
const sourceForProjectIssue = (
  path: readonly PropertyKey[],
  sources: ResourceSources,
): { path: PropertyKey[]; source: string } => {
  const [collection, rawIndex, field, ...remaining] = path;
  if (collection === 'project') return { path: path.slice(1), source: PROJECT_MANIFEST_FILE };
  const index = typeof rawIndex === 'number' ? rawIndex : -1;
  const fieldPath = field === undefined ? remaining : [field, ...remaining];
  if (collection === 'datasets') {
    const datasetSource = sources.datasets[index];
    if (field === 'metadata') {
      return { path: remaining, source: datasetSource?.metadata ?? PROJECT_MANIFEST_FILE };
    }
    return { path: fieldPath, source: datasetSource?.data ?? PROJECT_MANIFEST_FILE };
  }
  const collectionSources =
    collection === 'agents' || collection === 'metrics' || collection === 'tests'
      ? sources[collection]
      : undefined;
  return { path: fieldPath, source: collectionSources?.[index] ?? PROJECT_MANIFEST_FILE };
};

/** Loads each manifest entry in order; failures stay in each result's diagnostics. */
const loadJsonResources = async <Value>(
  root: string,
  entries: readonly { content_hash: string; path: string }[],
  schema: z.ZodType<Value>,
): Promise<LoadedJsonResource<Value>[]> => {
  const loads: LoadedJsonResource<Value>[] = [];
  for (const entry of entries) {
    loads.push(await loadJsonResource(root, entry.path, entry.content_hash, schema));
  }
  return loads;
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

  const { resources } = manifest.value;
  const agentLoads = await loadJsonResources(
    discovered.root,
    resources.agents,
    agentResourceSchema,
  );
  const testLoads = await loadJsonResources(discovered.root, resources.tests, testResourceSchema);
  const datasetLoads: LoadedDatasetResource[] = [];
  for (const entry of resources.datasets) {
    datasetLoads.push(await loadDataset(discovered.root, entry));
  }
  const metricLoads = await loadJsonResources(
    discovered.root,
    resources.metrics,
    metricResourceSchema,
  );

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
