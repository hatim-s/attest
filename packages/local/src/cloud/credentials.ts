import { rm } from 'node:fs/promises';

import { z } from 'zod';

import { LocalError } from '../errors/local-error.js';
import {
  assertPrivateAncestors,
  readPrivateFile,
  writePrivateFile,
} from '../internal/private-file.js';
import { normalizeCloudUrl } from './client.js';
import { bearerTokenSchema } from './protocol.js';

const credentialSchema = z
  .object({ baseUrl: z.string(), accessToken: bearerTokenSchema, expiresAt: z.string().datetime() })
  .strict();

type CloudCredentials = z.infer<typeof credentialSchema>;

/** Reads a private credential file without following a substituted symbolic link. */
const readCloudCredentials = async (
  path: string,
  options: { allowExpired?: boolean } = {},
): Promise<CloudCredentials> => {
  try {
    const text = await readPrivateFile(path);

    if (text.length > 16_384) throw new Error('Unsafe credentials');
    const credentials = credentialSchema.parse(JSON.parse(text));
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
    await writePrivateFile(path, JSON.stringify(credentials));
  } catch {
    throw new LocalError('cloud_credentials_failed', 'Could not save private cloud credentials.');
  }
};

/** Removes the locally stored bearer token after its cloud session has been revoked. */
const removeCloudCredentials = async (path: string): Promise<void> => {
  try {
    await assertPrivateAncestors(path);
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
};
