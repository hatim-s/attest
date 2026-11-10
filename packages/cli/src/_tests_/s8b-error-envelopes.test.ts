import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StoreError } from '@attest/core';
import * as Effect from 'effect/Effect';
import * as store from '@attest/local/store';
import { describe, expect, it, vi } from 'vitest';
import { createFixtureProject, runJson } from './support/cli-test-support.js';

describe('CLI error envelopes', () => {
  it('preserves StoreError cause_code and the public message', async () => {
    const root = await realpath(await createFixtureProject());

    const open = vi
      .spyOn(store, 'openStore')
      .mockReturnValue(Effect.fail(new StoreError('WRITE_FAILED', 'secret store path')));

    try {
      const result = await runJson(root, ['agent', 'test', 'support', '--record']);
      expect(result.exitCode).toBe(4);

      if (result.document.ok) throw new Error('Expected recording to fail.');
      expect(result.document.error).toEqual({
        code: 'internal_error',
        message: 'The command failed with an unclassified Attest error.',
        hint: 'Retry with the latest Attest version and report the stable error details.',
        retryable: false,
        details: { cause_code: 'WRITE_FAILED' },
      });
    } finally {
      open.mockRestore();
    }
  });

  it('B3 redacts the raw filesystem failure when recording cannot create .attest', async () => {
    const root = await realpath(await createFixtureProject());
    await writeFile(join(root, '.attest'), 'blocked');
    const result = await runJson(root, ['agent', 'test', 'support', '--record']);
    expect(result.exitCode).toBe(4);

    if (result.document.ok) throw new Error('Expected recording to fail.');
    expect(result.document.error).toEqual({
      code: 'internal_error',
      message: 'The command failed with an unknown internal error.',
      hint: 'Retry with the latest Attest version and report the stable error details.',
      retryable: false,
    });
    expect(JSON.stringify(result.document.error)).not.toContain(root);
  });
});
