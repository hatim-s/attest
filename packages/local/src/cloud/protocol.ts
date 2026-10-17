import { portableProjectBundleSchema } from '@attest/contracts';
import { z } from 'zod';

import { LocalError } from '../errors/local-error.js';

const bearerTokenSchema = z.string().regex(/^[\x21-\x7e]+$/u);

/** Keeps endpoint failures free of raw response values. */
// BOUNDARY: Decoded cloud responses are untrusted; each endpoint schema owns their validation.
const parseCloudEndpoint = <T>(schema: z.ZodType<T>, value: unknown): T => {
  try {
    return schema.parse(value);
  } catch {
    throw new LocalError(
      'cloud_request_failed',
      'Cloud returned a response that does not match the protocol.',
    );
  }
};

const deviceSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  expires_in: z.number().positive().max(3600),
  interval: z.number().positive().max(60),
});

const tokenSchema = z.object({
  access_token: bearerTokenSchema,
  token_type: z.literal('Bearer'),
  expires_in: z
    .number()
    .positive()
    .max(366 * 24 * 60 * 60),
});

type LoginNotice = Pick<
  z.infer<typeof deviceSchema>,
  'user_code' | 'verification_uri' | 'expires_in'
>;

const eventPageSchema = z.object({
  events: z.array(
    z.object({
      sequence: z.number().int().nonnegative(),
      time: z.string(),
      event: z.string(),
      data: z.unknown(),
    }),
  ),
  next_cursor: z.number().int().nonnegative(),
});

type CloudEventPage = z.infer<typeof eventPageSchema>;

const projectSchema = z.object({ id: z.string(), name: z.string(), created_at: z.string() });

const runSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  revision_id: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  cancel_requested: z.boolean(),
  raw_expires_at: z.string().nullable(),
  error_code: z.string().nullable(),
});

const runResponseSchema = z.object({ run: runSchema });

const revisionSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  created_at: z.string(),
});

const revisionResponseSchema = z.object({ revision: revisionSchema });

const revisionBundleSchema = revisionResponseSchema.extend({ bundle: portableProjectBundleSchema });

const projectsResponseSchema = z.object({ projects: z.array(projectSchema) });

const projectResponseSchema = z.object({ project: projectSchema });

const linkedProjectSchema = z.object({ project: z.object({ id: z.string() }) });

const runResultSchema = z.object({
  run: runSchema,
  summary: z.unknown(),
  raw: z.unknown(),
  raw_expired: z.boolean(),
});

const emptyResponseSchema = z.undefined();

const remoteErrorSchema = z.object({
  error: z.object({ code: z.string().regex(/^[a-z_]{1,80}$/u) }).optional(),
});

/** Preserves protocol polling outcomes without decoding error details at the caller. */
class CloudRemoteError extends LocalError {
  readonly outcome: 'authorization_pending' | 'request_failed';
  constructor(
    readonly status: number,
    readonly remoteCode: string,
  ) {
    super(
      status === 401 ? 'cloud_auth_required' : 'cloud_request_failed',
      `Cloud request failed (${status}, ${remoteCode}).`,
      { details: { status, remote_code: remoteCode } },
    );
    this.outcome =
      remoteCode === 'authorization_pending' ? 'authorization_pending' : 'request_failed';
  }
}

/** Keeps error bodies opaque except for the server's bounded code vocabulary. */
// BOUNDARY: Remote failure JSON is untrusted; only the error-code schema is consumed here.
const decodeRemoteError = (value: unknown): string => {
  try {
    return remoteErrorSchema.parse(value).error?.code ?? 'request_failed';
  } catch {
    return 'request_failed';
  }
};

export {
  parseCloudEndpoint,
  bearerTokenSchema,
  deviceSchema,
  tokenSchema,
  eventPageSchema,
  runResponseSchema,
  projectsResponseSchema,
  projectResponseSchema,
  linkedProjectSchema,
  runResultSchema,
  emptyResponseSchema,
  revisionResponseSchema,
  revisionBundleSchema,
  CloudRemoteError,
  decodeRemoteError,
  type LoginNotice,
  type CloudEventPage,
};
