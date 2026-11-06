import * as Effect from 'effect/Effect';
import { stripStruct } from '@attest/contracts';
import {
  parseWithSchemaSync,
  parseWithSchema,
  portableProjectBundleSchema,
} from '@attest/contracts';
import * as Schema from 'effect/Schema';

import { LocalError } from '../errors/local-error.js';

const bearerTokenSchema = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]+$/u));

/** Keeps endpoint failures free of raw response values. */
// BOUNDARY: Decoded cloud responses are untrusted; each endpoint schema owns their validation.
const parseCloudEndpoint = <T>(schema: Schema.ConstraintDecoder<T>, value: unknown): T => {
  try {
    return parseWithSchemaSync(schema, value);
  } catch {
    throw new LocalError(
      'cloud_request_failed',
      'Cloud returned a response that does not match the protocol.',
    );
  }
};

const deviceSchema = stripStruct({
  device_code: Schema.String.check(Schema.isMinLength(1)),
  user_code: Schema.String.check(Schema.isMinLength(1)),
  verification_uri: Schema.String.check(Schema.makeFilter((value) => URL.canParse(value))),
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(3600)),
  interval: Schema.Finite.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(60)),
});

const tokenSchema = stripStruct({
  access_token: bearerTokenSchema,
  token_type: Schema.Literal('Bearer'),
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)).check(
    Schema.isLessThanOrEqualTo(366 * 24 * 60 * 60),
  ),
});

type LoginNotice = Pick<typeof deviceSchema.Type, 'user_code' | 'verification_uri' | 'expires_in'>;

const eventPageSchema = stripStruct({
  events: Schema.Array(
    stripStruct({
      sequence: Schema.Finite.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
      ).check(Schema.isGreaterThanOrEqualTo(0)),
      time: Schema.String,
      event: Schema.String,
      data: Schema.Unknown,
    }),
  ),
  next_cursor: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
  ).check(Schema.isGreaterThanOrEqualTo(0)),
});

type CloudEventPage = typeof eventPageSchema.Type;

const projectSchema = stripStruct({
  id: Schema.String,
  name: Schema.String,
  created_at: Schema.String,
});

const runSchema = stripStruct({
  id: Schema.String,
  project_id: Schema.String,
  revision_id: Schema.String,
  status: Schema.Literals(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  created_at: Schema.String,
  started_at: Schema.NullOr(Schema.String),
  finished_at: Schema.NullOr(Schema.String),
  cancel_requested: Schema.Boolean,
  raw_expires_at: Schema.NullOr(Schema.String),
  error_code: Schema.NullOr(Schema.String),
});

const runResponseSchema = stripStruct({ run: runSchema });

const revisionSchema = stripStruct({
  id: Schema.String.check(Schema.isMinLength(1)),
  project_id: Schema.String.check(Schema.isMinLength(1)),
  created_at: Schema.String,
});

const revisionResponseSchema = stripStruct({ revision: revisionSchema });

const revisionBundleSchema = stripStruct({
  ...revisionResponseSchema.from.schema.fields,
  ...{ bundle: portableProjectBundleSchema },
});

const projectsResponseSchema = stripStruct({ projects: Schema.Array(projectSchema) });

const projectResponseSchema = stripStruct({ project: projectSchema });

const linkedProjectSchema = stripStruct({ project: stripStruct({ id: Schema.String }) });

const runResultSchema = stripStruct({
  run: runSchema,
  summary: Schema.Unknown,
  raw: Schema.Unknown,
  raw_expired: Schema.Boolean,
});

const projectTokenIdentitySchema = stripStruct({
  token: stripStruct({ project_id: Schema.String.check(Schema.isMinLength(1)) }),
});

const uploadedRunResponseSchema = stripStruct({
  run: stripStruct({
    id: Schema.String.check(Schema.isMinLength(1)),
    project_id: Schema.String.check(Schema.isMinLength(1)),
    url: Schema.String.check(Schema.makeFilter((value) => URL.canParse(value))),
  }),
  unchanged: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});

const projectTokenSchema = stripStruct({
  id: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String,
  created_at: Schema.String,
});

const createdProjectTokenSchema = stripStruct({
  token: projectTokenSchema,
  secret: bearerTokenSchema,
});

const projectTokensSchema = stripStruct({
  tokens: Schema.Array(
    stripStruct({
      ...projectTokenSchema.from.schema.fields,
      ...{ revoked_at: Schema.NullOr(Schema.String) },
    }),
  ),
});

const emptyResponseSchema = Schema.Unknown;

const uploadErrorCodes = [
  'upload_too_large',
  'run_not_finished',
  'run_conflict',
  'token_scope',
  'execution_unavailable',
  'invalid_bundle',
] as const;

const uploadErrorCodeSchema = Schema.Literals(uploadErrorCodes);

const remoteErrorSchema = stripStruct({
  error: Schema.optional(
    stripStruct({
      code: Schema.String.check(Schema.isPattern(/^[a-z_]{1,80}$/u)),
      message: Schema.optional(Schema.String),
    }),
  ),
});

const deviceErrorCodeSchema = Schema.Literals([
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
]);

type RemoteErrorOutcome =
  | { kind: 'device'; code: typeof deviceErrorCodeSchema.Type }
  | { kind: 'known'; code: typeof uploadErrorCodeSchema.Type; message: string }
  | { kind: 'remote'; remoteCode: string };

/** Preserves decoded device outcomes without reparsing error details at the caller. */
class CloudRemoteError extends LocalError {
  constructor(
    readonly status: number,
    readonly outcome: RemoteErrorOutcome,
  ) {
    const code = outcome.kind === 'remote' ? outcome.remoteCode : outcome.code;

    super(
      status === 401
        ? 'cloud_auth_required'
        : outcome.kind === 'known'
          ? outcome.code
          : 'cloud_request_failed',
      outcome.kind === 'known' ? outcome.message : `Cloud request failed (${status}, ${code}).`,
      { details: { status, remote_code: code } },
    );
  }
}

/** Decodes the RFC 8628 device vocabulary and keeps other server codes opaque. */
// BOUNDARY: Remote failure JSON is untrusted; only the error-code schemas are consumed here.
const decodeRemoteError = (value: unknown): RemoteErrorOutcome => {
  const parsed = parseWithSchema(remoteErrorSchema, value);

  if (!parsed.ok) return { kind: 'remote', remoteCode: 'request_failed' };
  const error = parsed.value.error;
  const remoteCode = error?.code ?? 'request_failed';
  const device = parseWithSchema(deviceErrorCodeSchema, remoteCode);

  if (device.ok) return { kind: 'device', code: device.value };
  const known = parseWithSchema(uploadErrorCodeSchema, remoteCode);

  if (known.ok) {
    return {
      kind: 'known',
      code: known.value,
      message: error?.message?.slice(0, 4096) ?? `Cloud request failed (${remoteCode}).`,
    };
  }

  return { kind: 'remote', remoteCode };
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
