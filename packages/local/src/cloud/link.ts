import { type AnchoredFileFailure, anchoredCall } from '../internal/open-anchored.js';
import { withOperationCleanup } from '../internal/operation-cleanup.js';
import * as Effect from 'effect/Effect';
import { parseWithSchema } from '@attest/contracts';
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as Schema from 'effect/Schema';
import { LocalError } from '../errors/index.js';
import { errnoCode } from '../internal/errno-code.js';
import { syncPath } from '../internal/sync-path.js';
import { discoverProject, type DiscoverProjectOptions } from '../project/discover-project.js';
import { resolveContainedPath } from '../project/project-path.js';
import { withProjectLock } from '../project/transaction/project-lock.js';
import type { CloudClient } from './client.js';
import { linkedProjectSchema } from './protocol.js';

const cloudLinkSchema = Schema.Struct({
  schema: Schema.Literal('attest.cloud-link.v1'),
  base_url: Schema.String.check(Schema.makeFilter((value) => URL.canParse(value))),
  project_id: Schema.String.check(Schema.isMinLength(1)),
  revision_id: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  file_hashes: Schema.Record(
    Schema.String,
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  ),
});

type CloudLink = typeof cloudLinkSchema.Type;

type CloudProjectOptions = DiscoverProjectOptions & {
  client: CloudClient;
  signal?: AbortSignal;
};

/** Resolves cloud state without following project-local symlinks. */
const cloudLinkPath = Effect.fn('cloudLinkPath')(function* (
  root: string,
  create: boolean = false,
): Effect.fn.Return<string, LocalError | AnchoredFileFailure> {
  return yield* resolveContainedPath(root, '.attest/cloud.json', {
    createDirectories: create,
    expect: 'file',
    problem: (): LocalError => new LocalError('project_invalid', 'Cloud link path is unsafe.'),
  });
});

/** Reads the origin-bound project link, rejecting malformed state rather than resetting it. */
const readCloudLink = Effect.fn('readCloudLink')(function* (root: string) {
  return yield* Effect.gen(function* () {
    const path = yield* cloudLinkPath(root);
    const raw = yield* anchoredCall('readFile', path, () => readFile(path, 'utf8'));

    const value = yield* Effect.try({
      // BOUNDARY: Link file JSON is decoded by cloudLinkSchema immediately below.
      try: () => {
        const value: unknown = JSON.parse(raw);

        return value;
      },
      catch: (cause) =>
        new LocalError('project_invalid', 'Cloud link is unreadable or invalid.', { cause }),
    });

    const parsed = parseWithSchema(cloudLinkSchema, value);

    if (!parsed.ok)
      return yield* new LocalError('project_invalid', 'Cloud link is unreadable or invalid.', {
        path: '.attest/cloud.json',
        cause: parsed.error,
      });

    return parsed.value;
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (errnoCode(error) === 'ENOENT') return undefined;

        if (error instanceof LocalError) return yield* Effect.fail(error);

        return yield* Effect.fail(
          new LocalError('project_invalid', 'Cloud link is unreadable or invalid.', {
            path: '.attest/cloud.json',
            cause: error,
          }),
        );
      }),
    ),
  );
});

/** Keeps direct writes and recoverable completion byte-identical. */
const serializeCloudLink = (link: CloudLink): string => `${JSON.stringify(link, null, 2)}\n`;

/** Atomically saves project identity and the exact last synchronized file hashes. */
const writeCloudLink = Effect.fn('writeCloudLink')(function* (root: string, link: CloudLink) {
  const path = yield* cloudLinkPath(root, true);
  const temporary = `${path}.${randomUUID()}.tmp`;

  return yield* withOperationCleanup(
    Effect.gen(function* () {
      yield* anchoredCall('writeFile', 'cloud/registry', () =>
        writeFile(temporary, serializeCloudLink(link), {
          flag: 'wx',
          mode: 0o600,
        }),
      );
      yield* syncPath(temporary);
      yield* cloudLinkPath(root);
      yield* anchoredCall('rename', 'cloud/registry', () => rename(temporary, path));
      yield* syncPath(dirname(path));
    }),
    Effect.gen(function* () {
      yield* anchoredCall('unlink', temporary, () => unlink(temporary)).pipe(
        Effect.catch((cause) => (errnoCode(cause) === 'ENOENT' ? Effect.void : Effect.fail(cause))),
      );
    }),
    'project_saved_cleanup_failed',
  );
}, Effect.uninterruptible);

/** Resolves a linked project and prevents credentials for another origin from being used. */
const resolveCloudProject = Effect.fn('resolveCloudProject')(function* (
  options: CloudProjectOptions,
) {
  const { root } = yield* discoverProject(options);
  const link = yield* readCloudLink(root);

  if (link === undefined) {
    return yield* Effect.fail(
      new LocalError('cli_missing_input', 'This project is not linked to Attest Cloud.', {
        hint: 'Run attest cloud link <project-id> first.',
      }),
    );
  }

  if (link.base_url !== options.client.baseUrl) {
    return yield* Effect.fail(
      new LocalError('project_invalid', 'Project link belongs to a different cloud origin.', {
        hint: 'Log in to the linked origin or explicitly link this project again.',
      }),
    );
  }

  return { root, link, projectId: link.project_id, revisionId: link.revision_id };
});

/** Links an existing cloud project without claiming the local files match a revision. */
const linkCloudProject = Effect.fn('linkCloudProject')(function* (
  options: CloudProjectOptions & {
    projectId: string;
  },
) {
  const { root } = yield* discoverProject(options);

  const response = yield* options.client.request(
    'GET',
    `/v1/projects/${encodeURIComponent(options.projectId)}`,
    { schema: linkedProjectSchema },
  );

  if (response.project.id !== options.projectId) {
    return yield* Effect.fail(
      new LocalError('cloud_request_failed', 'Cloud returned a different or invalid project.'),
    );
  }

  return yield* withProjectLock(
    root,
    () =>
      Effect.gen(function* () {
        const current = yield* readCloudLink(root);

        if (
          current !== undefined &&
          (current.project_id !== options.projectId || current.base_url !== options.client.baseUrl)
        ) {
          return yield* Effect.fail(
            new LocalError(
              'project_changed',
              'This directory is already linked to another cloud project.',
              {
                hint: 'Use a separate project directory to avoid replacing synchronization history.',
              },
            ),
          );
        }

        const link: CloudLink = current ?? {
          schema: 'attest.cloud-link.v1',
          base_url: options.client.baseUrl,
          project_id: options.projectId,
          file_hashes: {},
        };

        yield* writeCloudLink(root, link);

        return { project_id: link.project_id, revision_id: link.revision_id ?? null };
      }),
    () => ({ committed: true }),
  );
}, Effect.uninterruptible);

export {
  linkCloudProject,
  readCloudLink,
  resolveCloudProject,
  writeCloudLink,
  serializeCloudLink,
  type CloudLink,
  type CloudProjectOptions,
};
