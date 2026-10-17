import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

import { z } from 'zod';

import { LocalError } from '../errors/local-error.js';
import { errnoCode } from '../internal/errno-code.js';
import { normalizeCloudUrl } from './client.js';
import { bearerTokenSchema } from './protocol.js';

const credentialSchema = z
  .object({ baseUrl: z.string(), accessToken: bearerTokenSchema, expiresAt: z.string().datetime() })
  .strict();

type CloudCredentials = z.infer<typeof credentialSchema>;

const defaultCredentialPath = (): string => join(homedir(), '.attest', 'cloud', 'credentials.json');

/** Rejects symlink ancestors before using the credential directory. */
const checkCredentialAncestors = async (path: string, create: boolean): Promise<void> => {
  const directory = dirname(resolve(path));
  const root = parse(directory).root;
  let current = root;

  for (const component of directory.slice(root.length).split('/')) {
    current = join(current, component);

    if (create)
      await mkdir(current, { mode: 0o700 }).catch((cause: unknown) => {
        if (errnoCode(cause) !== 'EEXIST') throw cause;
      });
    const metadata = await lstat(current);

    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error('Unsafe credential ancestor');
  }
};

/** Reads a private credential file without following a substituted symbolic link. */
const readCloudCredentials = async (
  path = defaultCredentialPath(),
  options: { allowExpired?: boolean } = {},
): Promise<CloudCredentials> => {
  try {
    await checkCredentialAncestors(path, false);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      const stat = await handle.stat();

      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16_384)
        throw new Error('Unsafe credentials');
      const credentials = credentialSchema.parse(JSON.parse(await handle.readFile('utf8')));
      normalizeCloudUrl(credentials.baseUrl);

      if (!options.allowExpired && Date.parse(credentials.expiresAt) <= Date.now())
        throw new Error('Expired credentials');

      return credentials;
    } finally {
      await handle.close();
    }
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
  path = defaultCredentialPath(),
): Promise<void> => {
  normalizeCloudUrl(credentials.baseUrl);
  const directory = dirname(path);
  const temporary = join(directory, `.credentials-${randomUUID()}`);

  try {
    await checkCredentialAncestors(path, true);
    await chmod(directory, 0o700);
    const handle = await open(temporary, 'wx', 0o600);

    try {
      await handle.writeFile(JSON.stringify(credentials));
      await handle.sync();
    } finally {
      await handle.close();
    }

    await checkCredentialAncestors(path, false);
    await rename(temporary, path);
  } catch {
    throw new LocalError('cloud_credentials_failed', 'Could not save private cloud credentials.');
  } finally {
    await rm(temporary, { force: true });
  }
};

/** Removes the locally stored bearer token after its cloud session has been revoked. */
const removeCloudCredentials = async (path = defaultCredentialPath()): Promise<void> => {
  try {
    await checkCredentialAncestors(path, false);
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
  defaultCredentialPath,
  type CloudCredentials,
};
