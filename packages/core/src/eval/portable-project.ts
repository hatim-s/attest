import {
  portableProjectBundleSchema,
  type PortableProjectBundle,
  type HttpRequestTemplate,
} from '@attest/contracts';

import { validatePortableMetricSource } from './portable-metric-source.js';

import { canonicalStringify, contentHash } from '../store/internal/canonical-json.js';
import { hashCanonicalJsonLines, hashProjectManifest } from './canonical-project.js';
import { EvalResolutionError, type ResolutionProject } from './resolution-project.js';

/** Rejects credential-bearing request configuration before it becomes an immutable revision. */
const assertPortableRequest = (request: HttpRequestTemplate): void => {
  const url = new URL(request.url);
  if (url.username || url.password || url.search) {
    throw new EvalResolutionError(
      'project_invalid',
      'Bundle request URLs must not contain credentials or query strings. Use query fields and secret references.',
    );
  }
  for (const [key, value] of [
    ...Object.entries(request.headers ?? {}),
    ...Object.entries(request.query ?? {}),
  ]) {
    if (
      /(?:authorization|cookie|token|secret|password|api[-_]?key)/iu.test(key) &&
      typeof value === 'string'
    ) {
      throw new EvalResolutionError(
        'project_invalid',
        `Request field ${key} must use an environment secret reference.`,
      );
    }
    if (typeof value !== 'string' && 'from_file' in value) {
      throw new EvalResolutionError(
        'project_invalid',
        'Cloud bundles require environment secret references.',
      );
    }
  }
};

/** Validates source/resource parity and computes the same snapshot hashes as the local loader. */
const resolvePortableProject = (input: PortableProjectBundle): ResolutionProject => {
  const { resources, files } = portableProjectBundleSchema.parse(input);
  const allowedFiles = new Set(['attest.project.json']);
  const checkJson = (path: string, value: unknown, expectedHash?: string): string => {
    allowedFiles.add(path);
    const source = files[path];
    if (source === undefined)
      throw new EvalResolutionError('project_invalid', `Bundle is missing ${path}.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new EvalResolutionError('project_invalid', `Invalid JSON in ${path}.`);
    }
    const hash = contentHash(parsed);
    if (
      canonicalStringify(parsed) !== canonicalStringify(value) ||
      (expectedHash !== undefined && hash !== expectedHash)
    ) {
      throw new EvalResolutionError(
        'project_invalid',
        `Bundle resource or hash differs from ${path}.`,
      );
    }
    return hash;
  };
  const manifest = checkJson('attest.project.json', resources.project);
  const authoredHashes = (kind: 'agents' | 'tests' | 'metrics') =>
    Object.fromEntries(
      resources.project.resources[kind].map((entry) => {
        const resource = resources[kind].find(({ id }) => id === entry.id)!;
        return [entry.id, checkJson(entry.path, resource, entry.content_hash)];
      }),
    );
  const contentHashes = {
    manifest,
    agents: authoredHashes('agents'),
    tests: authoredHashes('tests'),
    metrics: authoredHashes('metrics'),
    datasets: Object.fromEntries(
      resources.project.resources.datasets.map((entry) => {
        const dataset = resources.datasets.find(({ metadata }) => metadata.id === entry.id)!;
        const metadata = checkJson(
          entry.metadata_path,
          dataset.metadata,
          entry.metadata_content_hash,
        );
        allowedFiles.add(entry.data_path);
        const source = files[entry.data_path];
        if (source === undefined)
          throw new EvalResolutionError('project_invalid', `Bundle is missing ${entry.data_path}.`);
        let rows: unknown[];
        try {
          rows = source
            .split(/\r?\n/u)
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as unknown);
        } catch {
          throw new EvalResolutionError('project_invalid', `Invalid JSONL in ${entry.data_path}.`);
        }
        const data = hashCanonicalJsonLines(rows);
        if (
          canonicalStringify(rows) !== canonicalStringify(dataset.cases) ||
          data !== entry.data_content_hash
        ) {
          throw new EvalResolutionError(
            'project_invalid',
            `Bundle dataset or hash differs from ${entry.data_path}.`,
          );
        }
        return [entry.id, { data, metadata }];
      }),
    ),
  };
  for (const path of Object.keys(files)) {
    if (/\.(?:ts|py)$/u.test(path)) validatePortableMetricSource(path, files[path]!);
    if (
      !allowedFiles.has(path) &&
      !/^attest\/metrics\/code\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:ts|py)$/u.test(path)
    ) {
      throw new EvalResolutionError('project_invalid', `Unreferenced bundle file ${path}.`);
    }
  }
  for (const { transport } of resources.agents) {
    if ('request' in transport) assertPortableRequest(transport.request);
    if (transport.kind === 'polling') assertPortableRequest(transport.submit);
  }
  for (const { definition } of resources.metrics) {
    if (definition.kind === 'http') assertPortableRequest(definition.request);
    if (
      definition.kind === 'exec' &&
      Object.values(definition.env ?? {}).some((reference) => 'from_file' in reference)
    ) {
      throw new EvalResolutionError(
        'project_invalid',
        'Cloud metric environment must use environment secret references.',
      );
    }
  }
  return {
    ...resources,
    contentHashes,
    projectHash: hashProjectManifest(
      resources.project,
      resources.datasets.map(({ metadata }) => metadata),
    ),
  };
};

export { resolvePortableProject };
