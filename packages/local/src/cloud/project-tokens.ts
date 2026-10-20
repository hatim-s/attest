import { LocalError } from '../errors/local-error.js';
import { resolveCloudProject, type CloudProjectOptions } from './link.js';
import { createdProjectTokenSchema, emptyResponseSchema, projectTokensSchema } from './protocol.js';

/** Rejects CI tokens before any server call, including project discovery. */
const tokenProject = async (options: CloudProjectOptions) => {
  if (options.client.credentialSource === 'project_token') {
    throw new LocalError(
      'token_scope',
      'Token management requires a saved device session. Unset ATTEST_CLOUD_URL and ATTEST_CLOUD_TOKEN.',
    );
  }

  const { client } = options;
  const { projectId } = await resolveCloudProject({ ...options, client });

  return { client, path: `/v1/projects/${encodeURIComponent(projectId)}/tokens` };
};

/** Returns a newly minted secret once, without persisting it locally. */
const createCloudProjectToken = async (options: CloudProjectOptions & { name: string }) => {
  const { client, path } = await tokenProject(options);

  return client.request('POST', path, {
    body: { name: options.name },
    schema: createdProjectTokenSchema,
  });
};

/** Lists token metadata without retrieving secrets. */
const listCloudProjectTokens = async (options: CloudProjectOptions) => {
  const { client, path } = await tokenProject(options);

  return client.request('GET', path, { schema: projectTokensSchema });
};

/** Revokes one token while leaving the server audit record intact. */
const revokeCloudProjectToken = async (options: CloudProjectOptions & { tokenId: string }) => {
  const { client, path } = await tokenProject(options);
  await client.request('DELETE', `${path}/${encodeURIComponent(options.tokenId)}`, {
    schema: emptyResponseSchema,
  });

  return { revoked: true, token_id: options.tokenId };
};

export { createCloudProjectToken, listCloudProjectTokens, revokeCloudProjectToken };
