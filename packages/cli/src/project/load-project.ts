import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  agentResourceSchema,
  datasetResourceSchema,
  metricResourceSchema,
  projectManifestSchema,
  projectResourcesSchema,
  testCaseSchema,
  testResourceSchema,
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
  hashDatasetMetadata,
  type JsonValue,
} from './canonical-project.js';
import {
  PROJECT_MANIFEST_FILE,
  discoverProject,
  type DiscoverProjectOptions,
} from './discover-project.js';
import { ProjectLoadError, type ProjectDiagnostic } from './project-errors.js';

type ProjectContentHashes = {
  agents: Readonly<Record<string, string>>;
  datasets: Readonly<Record<string, { data: string; metadata: string }>>;
  manifest: string;
  metrics: Readonly<Record<string, string>>;
  tests: Readonly<Record<string, string>>;
};

type LoadedProject = ProjectResources & {
  contentHashes: ProjectContentHashes;
  manifestPath: string;
  projectHash: string;
  root: string;
};

type SchemaIssue = {
  message: string;
  path: PropertyKey[];
};

type RuntimeSchema<T> = {
  safeParse: (
    value: unknown,
  ) => { data: T; success: true } | { error: { issues: readonly SchemaIssue[] }; success: false };
};

type LoadedJsonResource<T> = {
  diagnostics: ProjectDiagnostic[];
  hash?: string;
  source: string;
  value?: T;
};

type LoadedDatasetResource = {
  caseLines: number[];
  dataHash?: string;
  diagnostics: ProjectDiagnostic[];
  metadataHash?: string;
  source: { data: string; metadata: string };
  value?: { cases: TestCase[]; metadata: DatasetResource };
};

const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;

const isContainedPath = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
  );
};

const pointerEscape = (segment: PropertyKey): string =>
  String(segment).replaceAll('~', '~0').replaceAll('/', '~1');

const toJsonPointer = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? '' : `/${path.map(pointerEscape).join('/')}`;

/** Reads one project-relative file only after lexical and realpath containment checks. */
const readProjectSource = async (
  root: string,
  source: string,
): Promise<{ diagnostics: ProjectDiagnostic[]; text?: string }> => {
  const candidate = resolve(root, source);
  if (!isContainedPath(root, candidate)) {
    return {
      diagnostics: [
        {
          code: 'path_unsafe',
          message: 'path resolves outside the project root',
          source,
        },
      ],
    };
  }

  let resolvedSource: string;
  try {
    resolvedSource = await realpath(candidate);
  } catch (error: unknown) {
    return {
      diagnostics: [
        {
          code: getErrorCode(error) === 'ENOENT' ? 'source_missing' : 'source_unreadable',
          message:
            getErrorCode(error) === 'ENOENT'
              ? 'authored file does not exist'
              : 'authored file is not readable',
          source,
        },
      ],
    };
  }

  if (!isContainedPath(root, resolvedSource)) {
    return {
      diagnostics: [
        {
          code: 'path_unsafe',
          message: 'path resolves through a symlink outside the project root',
          source,
        },
      ],
    };
  }

  try {
    if (!(await stat(resolvedSource)).isFile()) {
      return {
        diagnostics: [
          {
            code: 'source_unreadable',
            message: 'authored path is not a regular file',
            source,
          },
        ],
      };
    }
    return { diagnostics: [], text: await readFile(resolvedSource, 'utf8') };
  } catch {
    return {
      diagnostics: [
        {
          code: 'source_unreadable',
          message: 'authored file is not readable',
          source,
        },
      ],
    };
  }
};

/** Parses JSON without forwarding parser excerpts that may contain authored secret values. */
const parseJson = (
  text: string,
  source: string,
  path?: string,
): { diagnostics: ProjectDiagnostic[]; value?: JsonValue } => {
  try {
    return { diagnostics: [], value: JSON.parse(text) as JsonValue };
  } catch {
    return {
      diagnostics: [
        {
          code: 'json_invalid',
          message: 'could not parse JSON',
          path,
          source,
        },
      ],
    };
  }
};

const schemaDiagnostics = (
  source: string,
  issues: readonly SchemaIssue[],
  prefix: readonly PropertyKey[] = [],
): ProjectDiagnostic[] =>
  issues.map((issue) => ({
    code: 'schema_invalid',
    message: issue.message,
    path: toJsonPointer([...prefix, ...issue.path]),
    source,
  }));

/** Loads, validates, and hashes one canonical JSON resource while retaining every issue. */
const loadJsonResource = async <T>(
  root: string,
  source: string,
  expectedHash: string | undefined,
  schema: RuntimeSchema<T>,
  hashValue: (value: JsonValue) => string = hashCanonicalJson,
): Promise<LoadedJsonResource<T>> => {
  const loaded = await readProjectSource(root, source);
  if (loaded.text === undefined) {
    return { diagnostics: loaded.diagnostics, source };
  }
  const parsed = parseJson(loaded.text, source);
  if (parsed.value === undefined) {
    return { diagnostics: parsed.diagnostics, source };
  }

  const hash = hashValue(parsed.value);
  const diagnostics = [...parsed.diagnostics];
  if (expectedHash !== undefined && expectedHash !== hash) {
    diagnostics.push({
      code: 'content_hash_mismatch',
      message: `canonical SHA-256 is ${hash}, manifest records ${expectedHash}`,
      source,
    });
  }

  const validated = schema.safeParse(parsed.value);
  if (!validated.success) {
    diagnostics.push(...schemaDiagnostics(source, validated.error.issues));
    return { diagnostics, hash, source };
  }
  return { diagnostics, hash, source, value: validated.data };
};

/** Loads an ordered JSONL dataset and preserves physical line context for every row failure. */
const loadDataset = async (
  root: string,
  entry: ProjectManifest['resources']['datasets'][number],
): Promise<LoadedDatasetResource> => {
  const metadata = await loadJsonResource(
    root,
    entry.metadata_path,
    entry.metadata_content_hash,
    datasetResourceSchema,
    hashDatasetMetadata,
  );
  const loadedData = await readProjectSource(root, entry.data_path);
  const diagnostics = [...metadata.diagnostics, ...loadedData.diagnostics];
  const cases: TestCase[] = [];
  const caseLines: number[] = [];
  const canonicalRecords: JsonValue[] = [];

  if (loadedData.text === undefined) {
    return {
      caseLines,
      diagnostics,
      metadataHash: metadata.hash,
      source: { data: entry.data_path, metadata: entry.metadata_path },
    };
  }

  loadedData.text.split(/\r?\n/u).forEach((line, index) => {
    if (line.trim().length === 0) {
      return;
    }
    const lineNumber = index + 1;
    const parsed = parseJson(line, entry.data_path, `line ${lineNumber}`);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.value === undefined) {
      return;
    }
    canonicalRecords.push(parsed.value);
    const validated = testCaseSchema.safeParse(parsed.value);
    if (!validated.success) {
      diagnostics.push(
        ...schemaDiagnostics(entry.data_path, validated.error.issues, [`line ${lineNumber}`]),
      );
      return;
    }
    cases.push(validated.data);
    caseLines.push(lineNumber);
  });

  const dataHash = hashCanonicalJsonLines(canonicalRecords);
  if (dataHash !== entry.data_content_hash) {
    diagnostics.push({
      code: 'content_hash_mismatch',
      message: `canonical SHA-256 is ${dataHash}, manifest records ${entry.data_content_hash}`,
      source: entry.data_path,
    });
  }

  return {
    caseLines,
    dataHash,
    diagnostics,
    metadataHash: metadata.hash,
    source: { data: entry.data_path, metadata: entry.metadata_path },
    value:
      metadata.value === undefined || cases.length !== canonicalRecords.length
        ? undefined
        : { cases, metadata: metadata.value },
  };
};

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
  if (collection === 'project') {
    return { path: path.slice(1), source: PROJECT_MANIFEST_FILE };
  }
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

/** Loads the complete v2 read model and rejects it with aggregate source-safe diagnostics. */
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
    // A valid manifest commits every verified resource hash, so its canonical hash is the project hash.
    projectHash: manifest.hash,
    root: discovered.root,
  };
};

export { loadProject, type LoadedProject, type ProjectContentHashes };
