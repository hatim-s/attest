import type * as CloudAdapter from '@attest/local/cloud';
import { cliResultSchema } from '@attest/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand as executeCommand } from './support/cli-test-support.js';

const cloud = {
  push: vi.fn<typeof CloudAdapter.pushCloudProject>().mockResolvedValue({
    project_id: 'project',
    revision_id: 'rev',
    file_count: 0,
  }),
  run: vi.fn<typeof CloudAdapter.runCloud>().mockResolvedValue({
    run: {
      id: 'run',
      project_id: 'project',
      revision_id: 'revision',
      status: 'queued',
      created_at: '2026-08-08T10:00:00.000Z',
      started_at: null,
      finished_at: null,
      cancel_requested: false,
      raw_expires_at: null,
      error_code: null,
    },
  }),
};

const services = {
  cloud: {
    authenticatedCloudClient: () =>
      Promise.resolve({
        baseUrl: 'https://cloud.example.test',
        request: () =>
          Promise.reject(new Error('This command fixture should not send HTTP requests.')),
      }),
    resolveCloudProject: () =>
      Promise.resolve({
        root: process.cwd(),
        projectId: 'project',
        revisionId: 'revision',
        link: {
          schema: 'attest.cloud-link.v1' as const,
          base_url: 'https://cloud.example.test',
          project_id: 'project',
          revision_id: 'revision',
          file_hashes: {},
        },
      }),
    pushCloudProject: cloud.push,
    runCloud: cloud.run,
  },
};

const runCommand = (...[root, argv, options]: Parameters<typeof executeCommand>) =>
  executeCommand(root, argv, { ...options, services });

beforeEach(() => {
  cloud.push.mockClear();
  cloud.run.mockClear();
});

describe('cloud command translation', () => {
  it('requires the explicit --no-secrets flag to acknowledge a changed upload', async () => {
    const implicit = await runCommand(process.cwd(), ['cloud', 'push', '--output', 'json']);
    expect(implicit.exitCode).toBe(0);
    expect(cloud.push.mock.calls[0]?.[0]).toMatchObject({ acknowledgeNoSecrets: false });

    const explicit = await runCommand(process.cwd(), [
      'cloud',
      'push',
      '--no-secrets',
      '--output',
      'json',
    ]);

    expect(explicit.exitCode).toBe(0);
    expect(cloud.push.mock.calls[1]?.[0]).toMatchObject({ acknowledgeNoSecrets: true });
  });

  it('uses the eval selection contract, linked revision, and retained retry key', async () => {
    const result = await runCommand(process.cwd(), [
      'cloud',
      'run',
      'test-one',
      '--case',
      'case-one',
      '--tag',
      'fast',
      '--sample',
      '2',
      '--seed',
      'seed',
      '--idempotency-key',
      'retry-key',
      '--output',
      'json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(cloud.run.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'project',
      revisionId: 'revision',
      idempotencyKey: 'retry-key',
      request: {
        command: 'eval.run',
        test_ids: ['test-one'],
        case_ids: ['case-one'],
        tags: ['fast'],
        sample: { count: 2, seed: 'seed' },
      },
    });
    expect(result.output).toHaveLength(1);
    expect(cliResultSchema.parse(JSON.parse(result.output[0]!))).toMatchObject({
      ok: true,
      command: 'cloud.run',
      result: { idempotency_key: 'retry-key', run: { id: 'run' } },
    });
    expect(result.errors).toEqual(['Cloud submission retry key: retry-key']);

    const conflict = await runCommand(process.cwd(), [
      'cloud',
      'run',
      'test-one',
      '--all',
      '--output',
      'json',
    ]);

    expect(conflict.exitCode).toBe(2);
    expect(cloud.run).toHaveBeenCalledTimes(1);
  });
});
