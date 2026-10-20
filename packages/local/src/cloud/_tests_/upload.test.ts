import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBundle } from '@attest/core';
import { afterEach, expect, it, vi } from 'vitest';
import { openStore } from '../../store/run-store.js';
import { createCloudClient } from '../client.js';
import { writeCloudLink } from '../link.js';
import { resolveCloudUploadProject, uploadCloudRun } from '../upload.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('uploads the exact bundle of the newest finished run and leaves the store unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-upload-'));
  directories.push(root);
  await writeFile(join(root, 'attest.project.json'), '{}');
  await mkdir(join(root, '.attest'));
  await writeCloudLink(root, {
    schema: 'attest.cloud-link.v1',
    base_url: 'https://cloud.test',
    project_id: 'p',
    file_hashes: {},
  });
  const path = join(root, '.attest/runs.db');
  const store = await openStore(path);
  let expected = '';

  try {
    for (const { id, createdAt, finalize } of [
      { id: 'old', createdAt: '2026-10-19T00:00:00Z', finalize: true },
      { id: '01ARZ3NDEKTSV4RRFFQ69G5FAB', createdAt: '2026-10-20T00:00:00Z', finalize: false },
      ...Array.from({ length: 101 }, (_, i) => ({
        id: `running-${i}`,
        createdAt: '2026-10-21T00:00:00Z',
        finalize: false,
      })),
    ]) {
      const run = await store.runs.createRun(
        { schemaId: 'attest.project', configHash: 'hash', configJson: '{}' },
        { id, createdAt },
      );

      if (finalize) await store.runs.finalizeRun(run.id, 'completed');
    }

    await store.runs.recordCase(
      '01ARZ3NDEKTSV4RRFFQ69G5FAB',
      {
        caseId: 'unicode',
        suiteName: 'suite',
        outcome: 'completed',
        startedAt: '2026-10-20T00:00:00Z',
        durationMs: 1,
        request: {
          protocol: 'attest.agent-invocation',
          run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAB',
          case_id: 'unicode',
          input: 'café',
        },
        response: { output: '你好' },
        warnings: [],
        diagnostics: {},
        attempts: [],
        expectedMetrics: [],
      },
      [],
    );
    await store.runs.finalizeRun('01ARZ3NDEKTSV4RRFFQ69G5FAB', 'completed');
    const aggregate = await store.runs.getRunWithCases('01ARZ3NDEKTSV4RRFFQ69G5FAB');
    expected = `${createBundle(aggregate.run, aggregate.cases).lines.join('\n')}\n`;
  } finally {
    await store.close();
  }

  const before = await readFile(path);

  const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
    Promise.resolve(
      Response.json({
        run: {
          id: '01ARZ3NDEKTSV4RRFFQ69G5FAB',
          project_id: 'p',
          url: 'https://cloud.test/#/projects/p/runs/01ARZ3NDEKTSV4RRFFQ69G5FAB',
        },
        unchanged: true,
      }),
    ),
  );

  const client = createCloudClient({
    baseUrl: 'https://cloud.test',
    accessToken: 'session',
    fetch: fetcher,
  });

  expect(
    await uploadCloudRun(await resolveCloudUploadProject({ workingDirectory: root, client })),
  ).toEqual({
    url: 'https://cloud.test/#/projects/p/runs/01ARZ3NDEKTSV4RRFFQ69G5FAB',
    unchanged: true,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(new Request(fetcher.mock.calls[0]![0]).url).toBe(
    'https://cloud.test/v1/projects/p/runs/upload',
  );
  expect(fetcher.mock.calls[0]![1]).toMatchObject({
    method: 'POST',
    body: expected,
    redirect: 'error',
  });
  expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('content-type')).toBe(
    'application/x-ndjson',
  );
  expect(await readFile(path)).toEqual(before);
});
