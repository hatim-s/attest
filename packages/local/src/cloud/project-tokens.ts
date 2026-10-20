import { z } from 'zod';

import { LocalError } from '../errors/local-error.js';
import type { DiscoverProjectOptions } from '../project/discover-project.js';
import { createCloudClient } from './client.js';
import { resolveCloudCredentials } from './credentials.js';
import { resolveCloudProject } from './link.js';
import { createdProjectTokenSchema, emptyResponseSchema, projectTokensSchema } from './protocol.js';

type TokenOptions = DiscoverProjectOptions & { credentialPath: string };

/** Rejects CI tokens before any server call, including project discovery. */
const tokenProject = async (options: TokenOptions) => {
  const credentials = await resolveCloudCredentials(options.credentialPath);

  if (credentials.source === 'environment') {
    throw new LocalError(
      'token_scope',
      'Token management requires a saved device session. Unset ATTEST_CLOUD_URL and ATTEST_CLOUD_TOKEN.',
    );
  }

  const client = createCloudClient(credentials);
  const { projectId } = await resolveCloudProject({ ...options, client });

  return { client, path: `/v1/projects/${encodeURIComponent(projectId)}/tokens` };
};

/** Returns a newly minted secret once, without persisting it locally. */
const createCloudProjectToken = async (options: TokenOptions & { name: string }) => {
  const name = z.string().trim().min(1).max(200).safeParse(options.name);

  if (!name.success)
    throw new LocalError('cli_usage', 'Token name must contain 1 to 200 characters.');
  const { client, path } = await tokenProject(options);

  return client.request('POST', path, {
    body: { name: name.data },
    schema: createdProjectTokenSchema,
  });
};

/** Lists token metadata without retrieving secrets. */
const listCloudProjectTokens = async (options: TokenOptions) => {
  const { client, path } = await tokenProject(options);

  return client.request('GET', path, { schema: projectTokensSchema });
};

/** Revokes one token while leaving the server audit record intact. */
const revokeCloudProjectToken = async (options: TokenOptions & { tokenId: string }) => {
  const { client, path } = await tokenProject(options);
  await client.request('DELETE', `${path}/${encodeURIComponent(options.tokenId)}`, {
    schema: emptyResponseSchema,
  });

  return { revoked: true, token_id: options.tokenId };
};

export { createCloudProjectToken, listCloudProjectTokens, revokeCloudProjectToken };
