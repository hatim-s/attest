import { anchoredCall } from '../internal/open-anchored.js';
import * as Effect from 'effect/Effect';
import { utcTimestampSchema } from '../internal/utc-timestamp.js';
import { parseWithSchemaSync, parseWithSchema } from '@attest/contracts';
import { rm } from 'node:fs/promises';
import * as Schema from 'effect/Schema';
import { LocalError } from '../errors/local-error.js';
import {
  assertPrivateAncestors,
  readPrivateFile,
  writePrivateFile,
} from '../internal/private-file.js';
import { normalizeCloudUrl } from './client.js';
import { bearerTokenSchema } from './protocol.js';

const credentialSchema = Schema.Struct({
  baseUrl: Schema.String,
  accessToken: bearerTokenSchema,
  expiresAt: utcTimestampSchema,
});

type CloudCredentialSource = 'session' | 'project_token';

type CloudCredentials = typeof credentialSchema.Type;

/** Reads a private credential file without following a substituted symbolic link. */
const readCloudCredentials = Effect.fn('readCloudCredentials')(function* (
  path: string,
  options: {
    allowExpired?: boolean;
  } = {},
) {
  return yield* Effect.gen(function* () {
    const text = yield* readPrivateFile(path);

    if (text.length > 16384)
      return yield* new LocalError(
        'cloud_auth_required',
        'Cloud credentials are missing, expired, or unsafe.',
      );

    const credentials = yield* Effect.try({
      try: () => parseWithSchemaSync(credentialSchema, JSON.parse(text)),
      catch: (cause) =>
        new LocalError(
          'cloud_auth_required',
          'Cloud credentials are missing, expired, or unsafe.',
          { cause },
        ),
    });

    yield* normalizeCloudUrl(credentials.baseUrl);

    if (!options.allowExpired && Date.parse(credentials.expiresAt) <= Date.now())
      return yield* new LocalError(
        'cloud_auth_required',
        'Cloud credentials are missing, expired, or unsafe.',
      );

    return credentials;
  }).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        return yield* new LocalError(
          'cloud_auth_required',
          'Cloud credentials are missing, expired, or unsafe.',
          { hint: 'Run attest cloud login --url <cloud-origin>.' },
        );
      }),
    ),
  );
});

/** Replaces credentials atomically; neither the temporary file nor the destination is public. */
const writeCloudCredentials = Effect.fn('writeCloudCredentials')(function* (
  credentials: CloudCredentials,
  path: string,
) {
  yield* normalizeCloudUrl(credentials.baseUrl);

  return yield* Effect.gen(function* () {
    yield* writePrivateFile(path, JSON.stringify(credentials));
  }).pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        return yield* new LocalError(
          'cloud_credentials_failed',
          'Could not save private cloud credentials.',
          {
            cause,
          },
        );
      }),
    ),
  );
});

/** Resolves the CI pair before consulting private session state. */
const resolveCloudCredentials = Effect.fn('resolveCloudCredentials')(function* (path: string) {
  const baseUrl = process.env.ATTEST_CLOUD_URL;
  const accessToken = process.env.ATTEST_CLOUD_TOKEN;

  if (baseUrl === undefined && accessToken === undefined) {
    const credentials = yield* readCloudCredentials(path);

    return { ...credentials, credentialSource: 'session' as const };
  }

  if (
    baseUrl === undefined ||
    accessToken === undefined ||
    !parseWithSchema(bearerTokenSchema, accessToken).ok
  ) {
    return yield* new LocalError(
      'cloud_credentials_invalid',
      'Set ATTEST_CLOUD_URL and ATTEST_CLOUD_TOKEN together with valid values.',
    );
  }

  const normalizedBaseUrl = yield* normalizeCloudUrl(baseUrl).pipe(
    Effect.mapError(
      () =>
        new LocalError(
          'cloud_credentials_invalid',
          'ATTEST_CLOUD_URL must be a cloud HTTPS origin or HTTP loopback origin.',
        ),
    ),
  );

  return {
    baseUrl: normalizedBaseUrl,
    accessToken,
    credentialSource: 'project_token' as const,
  };
});

/** Removes the locally stored bearer token after its cloud session has been revoked. */
const removeCloudCredentials = Effect.fn('removeCloudCredentials')(function* (path: string) {
  return yield* Effect.gen(function* () {
    yield* assertPrivateAncestors(path);
    yield* anchoredCall('rm', 'cloud/registry', () => rm(path, { force: true }));
  }).pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        return yield* new LocalError(
          'cloud_credentials_failed',
          'Could not remove private cloud credentials.',
          { cause },
        );
      }),
    ),
  );
});

export {
  readCloudCredentials,
  writeCloudCredentials,
  removeCloudCredentials,
  type CloudCredentials,
  type CloudCredentialSource,
  resolveCloudCredentials,
};
