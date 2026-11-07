import * as Effect from 'effect/Effect';
import { LocalError } from '../errors/local-error.js';
import { resolveCloudProject, type CloudProjectOptions } from './link.js';
import { createdProjectTokenSchema, emptyResponseSchema, projectTokensSchema } from './protocol.js';

/** Rejects CI tokens before any server call, including project discovery. */
const tokenProject = Effect.fn('tokenProject')(function* (options: CloudProjectOptions) {
  if (options.client.credentialSource === 'project_token') {
    return yield* Effect.fail(
      new LocalError(
        'token_scope',
        'Token management requires a saved device session. Unset ATTEST_CLOUD_URL and ATTEST_CLOUD_TOKEN.',
      ),
    );
  }

  const { client } = options;
  const { projectId } = yield* resolveCloudProject({ ...options, client });

  return { client, path: `/v1/projects/${encodeURIComponent(projectId)}/tokens` };
});

/** Returns a newly minted secret once, without persisting it locally. */
const createCloudProjectToken = Effect.fn('createCloudProjectToken')(function* (
  options: CloudProjectOptions & {
    name: string;
  },
) {
  const { client, path } = yield* tokenProject(options);

  return yield* client.request('POST', path, {
    body: { name: options.name },
    schema: createdProjectTokenSchema,
  });
});

/** Lists token metadata without retrieving secrets. */
const listCloudProjectTokens = Effect.fn('listCloudProjectTokens')(function* (
  options: CloudProjectOptions,
) {
  const { client, path } = yield* tokenProject(options);

  return yield* client.request('GET', path, { schema: projectTokensSchema });
});

/** Revokes one token while leaving the server audit record intact. */
const revokeCloudProjectToken = Effect.fn('revokeCloudProjectToken')(function* (
  options: CloudProjectOptions & {
    tokenId: string;
  },
) {
  const { client, path } = yield* tokenProject(options);
  yield* client.request('DELETE', `${path}/${encodeURIComponent(options.tokenId)}`, {
    schema: emptyResponseSchema,
  });

  return { revoked: true, token_id: options.tokenId };
});

export { createCloudProjectToken, listCloudProjectTokens, revokeCloudProjectToken };
