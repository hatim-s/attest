import * as Effect from 'effect/Effect';
import { valueFromExit } from '../internal/effect-exit.js';
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
const readCloudCredentials = async (
  path: string,
  options: { allowExpired?: boolean } = {},
): Promise<CloudCredentials> => {
  try {
    // EFFECT-BRIDGE(S8c)
    const text = await Effect.runPromiseExit(readPrivateFile(path)).then((exit) =>
      valueFromExit(exit),
    );

    if (text.length > 16_384) throw new Error('Unsafe credentials');
    const credentials = parseWithSchemaSync(credentialSchema, JSON.parse(text));
    normalizeCloudUrl(credentials.baseUrl);

    if (!options.allowExpired && Date.parse(credentials.expiresAt) <= Date.now())
      throw new Error('Expired credentials');

    return credentials;
  } catch {
    throw new LocalError(
      'cloud_auth_required',
      'Cloud credentials are missing, expired, or unsafe.',
      { hint: 'Run attest cloud login --url <cloud-origin>.' },
    );
  }
};

/** Replaces credentials atomically; neither the temporary file nor the destination is public. */
const writeCloudCredentials = async (
  credentials: CloudCredentials,
  path: string,
): Promise<void> => {
  normalizeCloudUrl(credentials.baseUrl);

  try {
    // EFFECT-BRIDGE(S8c)
    await Effect.runPromiseExit(writePrivateFile(path, JSON.stringify(credentials))).then(
      valueFromExit,
    );
  } catch {
    throw new LocalError('cloud_credentials_failed', 'Could not save private cloud credentials.');
  }
};

/** Resolves the CI pair before consulting private session state. */
const resolveCloudCredentials = async (path: string) => {
  const baseUrl = process.env.ATTEST_CLOUD_URL;
  const accessToken = process.env.ATTEST_CLOUD_TOKEN;

  if (baseUrl === undefined && accessToken === undefined) {
    const credentials = await readCloudCredentials(path);

    return { ...credentials, credentialSource: 'session' as const };
  }

  if (
    baseUrl === undefined ||
    accessToken === undefined ||
    !parseWithSchema(bearerTokenSchema, accessToken).ok
  ) {
    throw new LocalError(
      'cloud_credentials_invalid',
      'Set ATTEST_CLOUD_URL and ATTEST_CLOUD_TOKEN together with valid values.',
    );
  }

  try {
    return {
      baseUrl: normalizeCloudUrl(baseUrl),
      accessToken,
      credentialSource: 'project_token' as const,
    };
  } catch {
    throw new LocalError(
      'cloud_credentials_invalid',
      'ATTEST_CLOUD_URL must be a cloud HTTPS origin or HTTP loopback origin.',
    );
  }
};

/** Removes the locally stored bearer token after its cloud session has been revoked. */
const removeCloudCredentials = async (path: string): Promise<void> => {
  try {
    // EFFECT-BRIDGE(S8c)
    await Effect.runPromiseExit(assertPrivateAncestors(path)).then((exit) => valueFromExit(exit));
    await rm(path, { force: true });
  } catch (cause: unknown) {
    throw new LocalError(
      'cloud_credentials_failed',
      'Could not remove private cloud credentials.',
      { cause },
    );
  }
};

export {
  readCloudCredentials,
  writeCloudCredentials,
  removeCloudCredentials,
  type CloudCredentials,
  type CloudCredentialSource,
  resolveCloudCredentials,
};
