import { z } from 'zod';
import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dashboardHtml } from '@attest/web/embedded';
import { AGENT_PROTOCOL } from '@attest/contracts';
import { createSingleProjectCatalog, type RunControl, type RunStore } from '@attest/core';
import { afterEach, describe, expect, it } from 'vitest';

import { openStore } from '../../store/run-store.js';

import { startViewServer } from '../start-view-server.js';
import type { ViewServerHandle } from '../types.js';

const directories: string[] = [];

const servers: ViewServerHandle[] = [];

const createRun = async (store: RunStore, pass: boolean): Promise<string> => {
  const run = await store.createRun({
    schemaId: 'attest.project',
    configHash: 'same-config',
    configJson: '{}',
  });

  await store.recordCase(
    run.id,
    {
      caseId: 'capital',
      suiteName: 'smoke',
      outcome: 'completed',
      startedAt: '2026-08-07T00:00:00.000Z',
      durationMs: 10,
      request: {
        protocol: AGENT_PROTOCOL,
        run_id: run.id,
        case_id: 'capital',
        input: { question: 'Capital of France?' },
      },
      response: { protocol: AGENT_PROTOCOL, output: { answer: pass ? 'Paris' : 'Lyon' } },
      warnings: [],
      diagnostics: {},
      attempts: [],
      expectedMetrics: ['answer'],
    },
    [
      {
        metricName: 'answer',
        kind: 'assertion',
        status: 'evaluated',
        score: pass ? 1 : 0,
        pass,
      },
    ],
  );
  await store.finalizeRun(run.id, 'completed');

  return run.id;
};

const createStoreFixture = async (): Promise<{
  baseRunId: string;
  candidateRunId: string;
  storePath: string;
}> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-view-server-'));
  directories.push(directory);
  const storePath = join(directory, 'runs.db');
  const store = (await openStore(storePath)).runs;

  try {
    const baseRunId = await createRun(store, true);
    const candidateRunId = await createRun(store, false);

    return { baseRunId, candidateRunId, storePath };
  } finally {
    await store.close();
  }
};

/** Serves the fixture store as the single project `demo`. */
const startFixtureServer = async (
  storePath: string,
  control?: RunControl,
): Promise<ViewServerHandle> => {
  const store = await openStore(storePath);

  const server = await startViewServer({
    catalog: createSingleProjectCatalog({ key: 'demo', name: 'Demo' }, store.runs),
    close: () => store.close(),
    control,
    indexHtml: dashboardHtml,
  });

  servers.push(server);

  return server;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('view server', () => {
  it('serves run, case, and diff reads from a loopback-only origin', async () => {
    const fixture = await createStoreFixture();

    const server = await startFixtureServer(fixture.storePath);

    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await fetch(server.url).then((response) => response.text())).toContain(
      'window.__ATTEST_BOOTSTRAP__=',
    );

    const runs = z
      .object({ items: z.array(z.object({ id: z.string() })) })
      .parse(
        await fetch(`${server.origin}/api/projects/demo/runs`).then((response) => response.json()),
      );

    expect(runs.items.map(({ id }) => id)).toEqual([fixture.candidateRunId, fixture.baseRunId]);
    await expect(
      fetch(
        `${server.origin}/api/projects/demo/runs/${fixture.baseRunId}/cases/smoke/capital`,
      ).then((response) => response.json()),
    ).resolves.toMatchObject({ caseId: 'capital', metrics: [{ pass: true }] });
    await expect(
      fetch(
        `${server.origin}/api/projects/demo/diffs/${fixture.baseRunId}/${fixture.candidateRunId}`,
      ).then((response) => response.json()),
    ).resolves.toMatchObject({ summary: { counts: { regressed: 1 } } });
  });

  it('rejects requests addressed to foreign hosts before exposing stored runs', async () => {
    const fixture = await createStoreFixture();

    const server = await startFixtureServer(fixture.storePath);

    const result = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        get(
          `${server.origin}/api/projects/demo/runs`,
          { headers: { Host: 'rebound.example.test' } },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
              body += chunk;
            });
            response.on('end', () => resolve({ status: response.statusCode, body }));
          },
        ).on('error', reject);
      },
    );

    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({
      error: { code: 'FORBIDDEN', message: 'Request origin is not allowed.' },
    });
  });

  it('lets only the dashboard origin start or cancel runs', async () => {
    const fixture = await createStoreFixture();
    const calls: string[] = [];

    const control: RunControl = {
      listTests: () => Promise.resolve([]),
      startRun: (projectKey) => {
        calls.push(`start ${projectKey}`);

        return Promise.resolve({ runId: 'run-new' });
      },
      cancelRun: (_projectKey, runId) => {
        calls.push(`cancel ${runId}`);

        return Promise.resolve({ outcome: 'cancellation_requested' });
      },
    };

    const server = await startFixtureServer(fixture.storePath, control);

    const post = (path: string, headers: Record<string, string>) =>
      fetch(`${server.origin}/api/projects/demo${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ selection: { all: true } }),
      });

    const refusedHeaders: Record<string, string>[] = [
      { Origin: 'http://attacker.example.test' },
      {},
      { Origin: server.origin, 'Sec-Fetch-Site': 'cross-site' },
    ];

    for (const headers of refusedHeaders) {
      for (const path of ['/runs', `/runs/${fixture.baseRunId}/cancel`]) {
        const refused = await post(path, headers);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({
          error: { code: 'FORBIDDEN', message: 'Request origin is not allowed.' },
        });
      }
    }

    const read = (headers: Record<string, string>) =>
      fetch(`${server.origin}/api/projects/demo/runs`, { headers }).then(({ status }) => status);

    expect(await read({ Origin: 'http://attacker.example.test' })).toBe(403);
    // An `<img>` on another site sends no Origin, but its browser says where it came from.
    expect(await read({ 'Sec-Fetch-Site': 'cross-site' })).toBe(403);
    expect(await read({ 'Sec-Fetch-Site': 'same-site' })).toBe(403);
    expect(calls).toEqual([]);
    // Clients outside a browser send neither header; the dashboard's own reads say same-origin.
    expect(await read({})).toBe(200);
    expect(await read({ 'Sec-Fetch-Site': 'same-origin' })).toBe(200);
    expect(await read({ 'Sec-Fetch-Site': 'none' })).toBe(200);

    const started = await post('/runs', { Origin: server.origin });
    expect(started.status).toBe(201);
    expect(await started.json()).toEqual({ runId: 'run-new' });
    const cancelled = await post(`/runs/${fixture.baseRunId}/cancel`, { Origin: server.origin });
    expect(cancelled.status).toBe(200);
    expect(calls).toEqual(['start demo', `cancel ${fixture.baseRunId}`]);
    await expect(fetch(server.url).then((response) => response.text())).resolves.toContain(
      '"capabilities":{"control":true}',
    );
  });
});
