import { z } from 'zod';
import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dashboardHtml } from '@attest/web/embedded';
import { AGENT_PROTOCOL } from '@attest/contracts';
import { createSingleProjectCatalog, type RunStore } from '@attest/core';
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
const startFixtureServer = async (storePath: string): Promise<ViewServerHandle> => {
  const store = await openStore(storePath);

  const server = await startViewServer({
    catalog: createSingleProjectCatalog({ key: 'demo', name: 'Demo' }, store.runs),
    close: () => store.close(),
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
});
