import { z } from 'zod';

import { projectResourcesSchema } from '../project/resources-snapshot.js';
import { evalRunRequestSchema } from '../eval/run.js';

const PORTABLE_MAX_FILES = 100;

const PORTABLE_MAX_FILE_BYTES = 1_048_576;

const PORTABLE_MAX_TOTAL_FILE_BYTES = 5_242_880;

/** Caps the complete serialized HTTP upload request, including its revision envelope. */
const PORTABLE_MAX_UPLOAD_BYTES = 5_242_880;

const portableFilePathSchema = z
  .string()
  .max(240)
  .regex(
    /^(?:attest\.project\.json|attest\/(?!.*(?:^|\/)\.)[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/[a-zA-Z0-9_-]+\.(?:meta\.json|json|jsonl|ts|py))$/u,
    'must be a canonical authored resource or metric source path below attest/',
  );

/** Carries existing authored resources and their UTF-8 source files across hosts. */
const portableProjectBundleSchema = z
  .strictObject({
    schema: z.literal('attest.project-bundle.v1'),
    resources: projectResourcesSchema,
    files: z
      .record(
        portableFilePathSchema,
        z
          .string()
          .refine(
            (value) =>
              !value.includes('\0') &&
              new TextEncoder().encode(value).byteLength <= PORTABLE_MAX_FILE_BYTES,
            `must be UTF-8 text without NUL bytes and at most ${PORTABLE_MAX_FILE_BYTES / 1024 ** 2} MiB`,
          ),
      )
      .meta({
        maxProperties: PORTABLE_MAX_FILES,
        $comment: `Runtime-only invariants: files contain no NUL and use at most ${PORTABLE_MAX_FILE_BYTES / 1024 ** 2} MiB per file and ${PORTABLE_MAX_TOTAL_FILE_BYTES / 1024 ** 2} MiB total decoded UTF-8 bytes.`,
      }),
  })
  .superRefine(({ files }, context) => {
    if (Object.keys(files).length > PORTABLE_MAX_FILES)
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: `at most ${PORTABLE_MAX_FILES} files are allowed`,
      });

    if (
      Object.values(files).reduce(
        (total, value) => total + new TextEncoder().encode(value).byteLength,
        0,
      ) > PORTABLE_MAX_TOTAL_FILE_BYTES
    )
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: `bundle files must total at most ${PORTABLE_MAX_TOTAL_FILE_BYTES / 1024 ** 2} MiB`,
      });
  });

/** Submits an immutable revision using the existing evaluation selection contract. */
const cloudRunRequestSchema = z.strictObject({
  revision_id: z.string().min(1).max(128),
  request: evalRunRequestSchema,
  idempotency_key: z.string().min(1).max(128),
});

/** Queue delivery carries identity only; workers load the authoritative persisted job. */
const cloudQueueMessageSchema = z.strictObject({ run_id: z.string().min(1).max(128) });

type PortableProjectBundle = z.infer<typeof portableProjectBundleSchema>;

type CloudRunRequest = z.infer<typeof cloudRunRequestSchema>;

type CloudQueueMessage = z.infer<typeof cloudQueueMessageSchema>;

export {
  PORTABLE_MAX_UPLOAD_BYTES,
  portableProjectBundleSchema,
  cloudRunRequestSchema,
  cloudQueueMessageSchema,
  type PortableProjectBundle,
  type CloudRunRequest,
  type CloudQueueMessage,
};
