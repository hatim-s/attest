import { anchoredCall } from '../internal/open-anchored.js';
import * as Effect from 'effect/Effect';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  parseWithSchema,
  PORTABLE_MAX_UPLOAD_BYTES,
  portableProjectBundleSchema,
  tryOwned,
} from '@attest/contracts';
import { EvalResolutionError, resolvePortableProject } from '@attest/core';
import { LocalError } from '../errors/index.js';
import { schemaIssueDiagnostics } from '../internal/schema-issue-diagnostics.js';
import { discoverProject } from '../project/discover-project.js';
import { loadProject, type LoadedProject } from '../project/project-loader/index.js';
import { withProjectLock } from '../project/transaction/project-lock.js';
import { resolveSafeProjectPath } from '../project/transaction/project-path.js';
import {
  prepareTransaction,
  readByteHash,
  recoverProjectTransactions,
  type TransactionFileChange,
} from '../project/transaction/transaction-journal.js';
import { runPreparedTransaction } from '../project/transaction/transactional-writer.js';
import {
  resolveCloudProject,
  writeCloudLink,
  serializeCloudLink,
  type CloudProjectOptions,
} from './link.js';
import { revisionResponseSchema, revisionBundleSchema } from './protocol.js';

const byteHash = (contents: string): string => createHash('sha256').update(contents).digest('hex');

const fileHashes = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).map(([path, contents]) => [path, byteHash(contents)]));

/** Lists only authored resources and explicitly referenced custom metric entrypoints. */
const projectFilePaths = Effect.fn('projectFilePaths')(function* (project: LoadedProject) {
  const resources = project.project.resources;

  const paths = new Set([
    'attest.project.json',
    ...resources.agents.map(({ path }) => path),
    ...resources.tests.map(({ path }) => path),
    ...resources.metrics.map(({ path }) => path),
    ...resources.datasets.flatMap(({ metadata_path, data_path }) => [metadata_path, data_path]),
  ]);

  for (const metric of project.metrics) {
    if (metric.definition.kind !== 'exec') continue;
    const script = metric.definition.argv[1];

    if (script === undefined) {
      return yield* new LocalError(
        'project_invalid',
        `Metric ${metric.id} needs a script entrypoint.`,
      );
    }

    paths.add(script);
  }

  return [...paths].sort();
});

/** Reads a portable snapshot without traversing the project tree or resolving secret values. */
const createCloudBundle = Effect.fn('createCloudBundle')(function* (project: LoadedProject) {
  const files: Record<string, string> = {};

  for (const path of yield* projectFilePaths(project)) {
    const destination = yield* resolveSafeProjectPath(project.root, path);
    const bytes = yield* anchoredCall('readFile', destination, () => readFile(destination));

    const contents = yield* Effect.try({
      try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      catch: () =>
        new LocalError('project_invalid', 'Cloud revisions support UTF-8 text files only.', {
          path,
        }),
    });

    if (contents.includes('\0')) {
      return yield* new LocalError(
        'project_invalid',
        'Cloud revisions support UTF-8 text files only.',
        { path },
      );
    }

    files[path] = contents;
  }

  const { agents, datasets, metrics, tests } = project;

  const parsed = parseWithSchema(portableProjectBundleSchema, {
    schema: 'attest.project-bundle.v1',
    resources: { agents, datasets, metrics, tests, project: project.project },
    files,
  });

  if (!parsed.ok) {
    return yield* new LocalError(
      'project_invalid',
      'Project cannot be uploaded as a cloud revision.',
      {
        details: { diagnostics: schemaIssueDiagnostics(parsed.error.issues) },
        hint: 'Keep custom metric code under attest/metrics/code and remove secrets from authored files.',
      },
    );
  }

  yield* tryOwned(EvalResolutionError, () => resolvePortableProject(parsed.value));

  return parsed.value;
});

/** Uploads an immutable revision after explicit acknowledgement that its authored files contain no secrets. */
const pushCloudProject = Effect.fn('pushCloudProject')(function* (
  options: CloudProjectOptions & {
    acknowledgeNoSecrets?: boolean;
  },
) {
  const { root } = yield* discoverProject(options);

  return yield* withProjectLock(
    root,
    (lock) =>
      Effect.gen(function* () {
        yield* recoverProjectTransactions(root, lock);
        const { link, projectId } = yield* resolveCloudProject(options);
        const bundle = yield* createCloudBundle(yield* loadProject({ project: root }));
        const hashes = fileHashes(bundle.files);

        const unchanged =
          JSON.stringify(Object.entries(hashes).sort()) ===
          JSON.stringify(Object.entries(link.file_hashes).sort());

        if (options.acknowledgeNoSecrets !== true && !unchanged) {
          return yield* new LocalError(
            'cli_usage',
            'Cloud push requires confirmation that changed authored files contain no secrets.',
            {
              hint: 'Inspect project resources, case data, and metric code, then pass --no-secrets.',
            },
          );
        }

        const payload = { bundle, parent_revision_id: link.revision_id ?? null };

        if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > PORTABLE_MAX_UPLOAD_BYTES) {
          return yield* new LocalError(
            'project_invalid',
            `Cloud revision exceeds the ${PORTABLE_MAX_UPLOAD_BYTES / (1024 * 1024)} MiB upload limit.`,
            {
              hint: 'Reduce authored dataset or metric source size before pushing.',
            },
          );
        }

        const response = yield* options.client.request(
          'POST',
          `/v1/projects/${encodeURIComponent(projectId)}/revisions`,
          { schema: revisionResponseSchema, body: payload },
        );

        if (response.revision.project_id !== projectId) {
          return yield* new LocalError(
            'project_invalid',
            'Cloud returned a revision for another project.',
          );
        }

        yield* writeCloudLink(root, {
          ...link,
          revision_id: response.revision.id,
          file_hashes: hashes,
        });

        return {
          project_id: projectId,
          revision_id: response.revision.id,
          file_count: Object.keys(bundle.files).length,
        };
      }),
    () => ({ committed: true }),
  );
}, Effect.uninterruptible);

/** Compares every overwritten or removed path with its synchronized base before staging writes. */
const planPullChanges = Effect.fn('planPullChanges')(function* (
  root: string,
  base: Record<string, string>,
  files: Record<string, string>,
) {
  const changes: TransactionFileChange[] = [];
  const conflicts: string[] = [];

  for (const path of new Set([...Object.keys(base), ...Object.keys(files)])) {
    const destination = yield* resolveSafeProjectPath(root, path);
    const currentHash = yield* readByteHash(destination);
    const next = files[path];
    const nextHash = next === undefined ? null : byteHash(next);

    if (currentHash !== nextHash && currentHash !== (base[path] ?? null)) {
      conflicts.push(path);
      continue;
    }

    if (currentHash !== nextHash || path === 'attest.project.json') {
      changes.push(
        next === undefined ? { path, type: 'remove' } : { path, type: 'write', contents: next },
      );
    }
  }

  if (conflicts.length > 0) {
    return yield* new LocalError('project_changed', 'Cloud pull would overwrite local changes.', {
      details: { conflicts },
      hint: 'Preserve or reconcile these files before pulling. Pull never discards local changes.',
    });
  }

  return changes.sort((left, right) =>
    left.path === 'attest.project.json'
      ? 1
      : right.path === 'attest.project.json'
        ? -1
        : left.path.localeCompare(right.path),
  );
});

/** Pulls one validated revision using the existing recoverable transaction journal. */
const pullCloudProject = Effect.fn('pullCloudProject')(function* (
  options: CloudProjectOptions & {
    revisionId?: string;
  },
) {
  const { root } = yield* discoverProject(options);

  return yield* withProjectLock(
    root,
    (lock) =>
      Effect.gen(function* () {
        yield* recoverProjectTransactions(root, lock);
        const { link, projectId } = yield* resolveCloudProject(options);

        const selected =
          options.revisionId === undefined ? 'current' : encodeURIComponent(options.revisionId);

        const response = yield* options.client.request(
          'GET',
          `/v1/projects/${encodeURIComponent(projectId)}/revisions/${selected}`,
          { schema: revisionBundleSchema },
        );

        if (
          response.revision.project_id !== projectId ||
          (options.revisionId !== undefined && response.revision.id !== options.revisionId)
        ) {
          return yield* new LocalError(
            'project_invalid',
            'Cloud returned a different project or revision.',
          );
        }

        yield* tryOwned(EvalResolutionError, () => resolvePortableProject(response.bundle));
        const changes = yield* planPullChanges(root, link.file_hashes, response.bundle.files);

        const prepared = yield* prepareTransaction(root, changes, {
          completion: {
            path: '.attest/cloud.json',
            contents: serializeCloudLink({
              ...link,
              revision_id: response.revision.id,
              file_hashes: fileHashes(response.bundle.files),
            }),
          },
        });

        yield* runPreparedTransaction({
          root,
          prepared,
          beforePublish: () =>
            Effect.gen(function* () {
              // A non-Attest editor may write after conflict planning but before staging.
              for (const entry of prepared.journal.entries) {
                const incoming = response.bundle.files[entry.path];
                const nextHash = incoming === undefined ? null : byteHash(incoming);

                if (
                  entry.original_hash !== (link.file_hashes[entry.path] ?? null) &&
                  entry.original_hash !== nextHash
                ) {
                  return yield* new LocalError(
                    'project_changed',
                    'A local file changed while cloud pull was staging.',
                    { path: entry.path },
                  );
                }
              }
            }),
          verify: () => loadProject({ project: root }),
        });

        return {
          project_id: projectId,
          revision_id: response.revision.id,
          file_count: Object.keys(response.bundle.files).length,
        };
      }),
    () => ({ committed: true }),
  );
}, Effect.uninterruptible);

export { createCloudBundle, planPullChanges, pullCloudProject, pushCloudProject };
