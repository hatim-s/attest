import * as Schema from 'effect/Schema';

import { refinePortableCredentials } from './portable-credentials.js';

import { projectResourcesSchema } from '../project/resources-snapshot.js';
import { evalRunRequestSchema } from '../eval/run.js';

const PORTABLE_MAX_FILES = 100;

const PORTABLE_MAX_FILE_BYTES = 1_048_576;

const PORTABLE_MAX_TOTAL_FILE_BYTES = 5_242_880;

/** Caps the complete serialized HTTP upload request, including its revision envelope. */
const PORTABLE_MAX_UPLOAD_BYTES = 5_242_880;

const portableFilePathSchema = Schema.String.check(Schema.isMaxLength(240)).check(
  Schema.isPattern(
    /^(?:attest\.project\.json|attest\/(?!.*(?:^|\/)\.)[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/[a-zA-Z0-9_-]+\.(?:meta\.json|json|jsonl|ts|py))$/u,
    { message: 'must be a canonical authored resource or metric source path below attest/' },
  ),
);

/** Carries existing authored resources and their UTF-8 source files across hosts. */
const portableProjectBundleSchema = Schema.Struct({
  schema: Schema.Literal('attest.project-bundle.v1'),
  resources: projectResourcesSchema,
  files: Schema.Record(
    portableFilePathSchema,
    Schema.String.check(
      Schema.makeFilter((value) =>
        !value.includes('\0') &&
        new TextEncoder().encode(value).byteLength <= PORTABLE_MAX_FILE_BYTES
          ? undefined
          : `must be UTF-8 text without NUL bytes and at most ${PORTABLE_MAX_FILE_BYTES / 1024 ** 2} MiB`,
      ),
    ),
  ),
}).check(
  Schema.makeFilter(({ files, resources }) => {
    const context: Schema.FilterIssue[] = [];
    refinePortableCredentials(resources, context);

    if (Object.keys(files).length > PORTABLE_MAX_FILES)
      context.push({
        path: ['files'],
        issue: `at most ${PORTABLE_MAX_FILES} files are allowed`,
      });

    if (
      Object.values(files).reduce(
        (total, value) => total + new TextEncoder().encode(value).byteLength,
        0,
      ) > PORTABLE_MAX_TOTAL_FILE_BYTES
    )
      context.push({
        path: ['files'],
        issue: `bundle files must total at most ${PORTABLE_MAX_TOTAL_FILE_BYTES / 1024 ** 2} MiB`,
      });

    return context;
  }),
);

/** Submits an immutable revision using the existing evaluation selection contract. */
const cloudRunRequestSchema = Schema.Struct({
  revision_id: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(128)),
  request: evalRunRequestSchema,
  idempotency_key: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(128)),
});

/** Queue delivery carries identity only; workers load the authoritative persisted job. */
const cloudQueueMessageSchema = Schema.Struct({
  run_id: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(128)),
});

type PortableProjectBundle = typeof portableProjectBundleSchema.Type;

type CloudRunRequest = typeof cloudRunRequestSchema.Type;

type CloudQueueMessage = typeof cloudQueueMessageSchema.Type;

export {
  PORTABLE_MAX_UPLOAD_BYTES,
  PORTABLE_MAX_FILES,
  portableProjectBundleSchema,
  cloudRunRequestSchema,
  cloudQueueMessageSchema,
  type PortableProjectBundle,
  type CloudRunRequest,
  type CloudQueueMessage,
};
