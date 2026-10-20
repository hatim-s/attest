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

const projectTokenIdentitySchema = z.object({
  token: z.object({ id: z.string().min(1), name: z.string(), project_id: z.string().min(1) }),
});

const uploadedRunResponseSchema = z.object({
  run: z.object({
    id: z.string().min(1),
    project_id: z.string().min(1),
    status: z.enum(['completed', 'failed', 'cancelled']),
    created_at: z.string(),
    finished_at: z.string(),
    git_sha: z.string().nullable(),
    git_branch: z.string().nullable(),
    labels: z.array(z.string()),
    summary: z.unknown(),
    url: z.url(),
  }),
  unchanged: z.boolean().optional(),
});

const projectTokenSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  created_at: z.string(),
});

const createdProjectTokenSchema = z.object({
  token: projectTokenSchema,
  secret: bearerTokenSchema,
});

const projectTokensSchema = z.object({ tokens: z.array(projectTokenSchema) });

const emptyResponseSchema = z.unknown();

const remoteErrorSchema = z.object({
  error: z.object({ code: z.string().regex(/^[a-z_]{1,80}$/u) }).optional(),
});

const deviceErrorCodeSchema = z.enum([
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
]);

type RemoteErrorOutcome =
  | { kind: 'device'; code: z.infer<typeof deviceErrorCodeSchema> }
  | { kind: 'remote'; remoteCode: string };

/** Preserves decoded device outcomes without reparsing error details at the caller. */
class CloudRemoteError extends LocalError {
  constructor(
    readonly status: number,
    readonly outcome: RemoteErrorOutcome,
  ) {
    const code = outcome.kind === 'device' ? outcome.code : outcome.remoteCode;
    super(
      status === 401 ? 'cloud_auth_required' : 'cloud_request_failed',
      `Cloud request failed (${status}, ${code}).`,
      { details: { status, remote_code: code } },
    );
  }
}

/** Decodes the RFC 8628 device vocabulary and keeps other server codes opaque. */
// BOUNDARY: Remote failure JSON is untrusted; only the error-code schemas are consumed here.
const decodeRemoteError = (value: unknown): RemoteErrorOutcome => {
  let remoteCode: string;

  try {
    remoteCode = remoteErrorSchema.parse(value).error?.code ?? 'request_failed';
  } catch {
    return { kind: 'remote', remoteCode: 'request_failed' };
  }

  const device = deviceErrorCodeSchema.safeParse(remoteCode);

  return device.success ? { kind: 'device', code: device.data } : { kind: 'remote', remoteCode };
};

export {
  uploadedRunResponseSchema,
  createdProjectTokenSchema,
  projectTokensSchema,
  projectTokenIdentitySchema,
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
