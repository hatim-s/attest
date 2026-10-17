import { z } from 'zod';
import { portableProjectBundleSchema, type PortableProjectBundle } from '@attest/contracts';

import { validatePortableMetricSource } from './portable-metric-source.js';

import { canonicalStringify, contentHash } from '../store/internal/canonical-json.js';
import { hashCanonicalJsonLines, hashProjectManifest } from './canonical-project.js';
import { EvalResolutionError, type ResolutionProject } from './resolution-project.js';

/** Validates source/resource parity and computes the same snapshot hashes as the local loader. */
// BOUNDARY: Uploaded portable project bundles are schema checked and their authored files and resource hashes are verified.
const resolvePortableProject = (input: PortableProjectBundle): ResolutionProject => {
  const parsed = portableProjectBundleSchema.safeParse(input);

  if (!parsed.success) {
    throw new EvalResolutionError('project_invalid', 'Invalid portable project bundle.', {
      details: {
        issues: parsed.error.issues.map(({ path, message }) => ({
          path: path.map(String),
          message,
        })),
      },
    });
  }

  const { resources, files } = parsed.data;
  const allowedFiles = new Set(['attest.project.json']);

  // BOUNDARY: Authored bundle files are decoded and compared to their resolved resource data and expected content hash.
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
            .map((line) => z.json().parse(JSON.parse(line)));
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
