import { cliResultSchema } from '@attest/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from './support/cli-test-support.js';

const cloud = vi.hoisted(() => ({
  push: vi.fn().mockResolvedValue({ revision_id: 'rev' }),
  run: vi.fn().mockResolvedValue({ run: { id: 'run' } }),
}));
vi.mock('@attest/local/cloud', async (importOriginal) => {
  const original = await importOriginal<typeof import('@attest/local/cloud')>();
  return {
    ...original,
    authenticatedCloudClient: vi.fn().mockResolvedValue({ baseUrl: 'https://cloud.example.test' }),
    resolveCloudProject: vi
      .fn()
      .mockResolvedValue({ projectId: 'project', revisionId: 'revision' }),
    pushCloudProject: cloud.push,
    runCloud: cloud.run,
  };
});
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
