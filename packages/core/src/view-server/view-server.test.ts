import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_PROTOCOL } from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { openRunStore } from '../store/run-store.js';
import type { RunStore } from '../store/types.js';
import { startViewServer } from './start-view-server.js';
import type { ViewServerHandle } from './types.js';

const directories: string[] = [];
const servers: ViewServerHandle[] = [];

const createRun = async (store: RunStore, pass: boolean): Promise<string> => {
  const run = await store.createRun({
    configVersion: '1',
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
  const store = await openRunStore(storePath);
  try {
    const baseRunId = await createRun(store, true);
    const candidateRunId = await createRun(store, false);
    return { baseRunId, candidateRunId, storePath };
  } finally {
    await store.close();
  }
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('view server', () => {
  it('serves versioned run, case, and diff reads from a loopback-only origin', async () => {
    const fixture = await createStoreFixture();
    const server = await startViewServer({ storePath: fixture.storePath });
    servers.push(server);

    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(
      fetch(`${server.origin}/api/v1/health`).then((response) => response.json()),
    ).resolves.toEqual({
      api_version: 'attest.view/v1',
      ok: true,
    });
    const runs = (await fetch(`${server.origin}/api/v1/runs`).then((response) =>
      response.json(),
    )) as { runs: Array<{ id: string }> };
    expect(runs.runs.map(({ id }) => id)).toEqual([fixture.candidateRunId, fixture.baseRunId]);
    await expect(
      fetch(`${server.origin}/api/v1/runs/${fixture.baseRunId}/cases/smoke/capital`).then(
        (response) => response.json(),
      ),
    ).resolves.toMatchObject({ case: { caseId: 'capital', metrics: [{ pass: true }] } });
    await expect(
      fetch(`${server.origin}/api/v1/diffs/${fixture.baseRunId}/${fixture.candidateRunId}`).then(
        (response) => response.json(),
      ),
    ).resolves.toMatchObject({ diff: { summary: { counts: { regressed: 1 } } } });
  });

  it('requires both exact origin and session token for shutdown writes', async () => {
    const fixture = await createStoreFixture();
    const server = await startViewServer({
      sessionToken: 'known-session-token',
      storePath: fixture.storePath,
    });
    servers.push(server);

    const missingOrigin = await fetch(`${server.origin}/api/v1/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.sessionToken}` },
    });
    expect(missingOrigin.status).toBe(403);

    const badToken = await fetch(`${server.origin}/api/v1/shutdown`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', Origin: server.origin },
    });
    expect(badToken.status).toBe(401);

    const accepted = await fetch(`${server.origin}/api/v1/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.sessionToken}`, Origin: server.origin },
    });
    expect(accepted.status).toBe(204);
    await server.closed;
    servers.splice(servers.indexOf(server), 1);
  });
});
