import { QueryClient } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { queryKeys } from '../query-keys.js';

const local = { sourceId: 'http://127.0.0.1:4400/api', projectKey: 'demo' };

const cloud = { sourceId: '/api', projectKey: 'demo' };

const seed = (client: QueryClient) => {
  for (const scope of [local, cloud]) {
    client.setQueryData(queryKeys.overviews(scope.sourceId), scope.sourceId);
    client.setQueryData(queryKeys.evals(scope), scope.sourceId);
    client.setQueryData(queryKeys.activity(scope, { from: 'a', to: 'b' }), scope.sourceId);
  }

  client.setQueryData(queryKeys.evals({ ...local, projectKey: 'other' }), 'other');
};

const invalidated = (client: QueryClient) =>
  client
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.isInvalidated)
    .map((query) => query.queryKey);

it('never shares a cache entry between sources for the same project key', () => {
  const client = new QueryClient();
  seed(client);

  expect(client.getQueryData(queryKeys.evals(local))).toBe(local.sourceId);
  expect(client.getQueryData(queryKeys.evals(cloud))).toBe(cloud.sourceId);
  expect(client.getQueryData(queryKeys.overviews(cloud.sourceId))).toBe(cloud.sourceId);
});

it('invalidates by source and by project prefix without touching other owners', async () => {
  const client = new QueryClient();
  seed(client);

  await client.invalidateQueries({ queryKey: queryKeys.project(local), refetchType: 'none' });
  expect(invalidated(client)).toEqual([
    queryKeys.evals(local),
    queryKeys.activity(local, { from: 'a', to: 'b' }),
  ]);

  client.clear();
  seed(client);
  await client.invalidateQueries({
    queryKey: queryKeys.source(cloud.sourceId),
    refetchType: 'none',
  });
  expect(invalidated(client)).toEqual([
    queryKeys.overviews(cloud.sourceId),
    queryKeys.evals(cloud),
    queryKeys.activity(cloud, { from: 'a', to: 'b' }),
  ]);
});
