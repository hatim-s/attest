import { z } from 'zod';

import { projectResourcesSchema } from '../project/resources-snapshot.js';
import { evalRunRequestSchema } from '../eval/run.js';

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
    files: z.record(
      portableFilePathSchema,
      z
        .string()
        .refine(
          (value) =>
            !value.includes('\0') && new TextEncoder().encode(value).byteLength <= 1_048_576,
          'must be UTF-8 text without NUL bytes and at most 1 MiB',
        ),
    ),
  })
  .superRefine(({ files }, context) => {
    if (Object.keys(files).length > 100)
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'at most 100 files are allowed',
      });
    if (
      Object.values(files).reduce(
        (total, value) => total + new TextEncoder().encode(value).byteLength,
        0,
      ) > 10_485_760
    )
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'bundle files must total at most 10 MiB',
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
  portableProjectBundleSchema,
  cloudRunRequestSchema,
  cloudQueueMessageSchema,
  type PortableProjectBundle,
  type CloudRunRequest,
  type CloudQueueMessage,
};
