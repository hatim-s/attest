import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StoreError } from '@attest/core';
import { openStore } from '../../store/index.js';
import { run } from '../../store/_tests_/store-fixture.js';
import { startPromiseStoreOwner } from '../promise-store-owner.js';

describe('Promise parent store ownership', () => {
  it('keeps storage usable after publication and closes only after terminal acknowledgement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attest-parent-owner-'));

    try {
      const lifetime = await startPromiseStoreOwner((owner) =>
        openStore(join(root, 'runs.db'), owner),
      );

      const runRecord = await run(
        lifetime.value.runs.createRun({ schemaId: 'test', configHash: 'test', configJson: '{}' }),
      );

      await run(lifetime.value.runs.finalizeRun(runRecord.id, 'completed'));
      await lifetime.finish();
      await expect(run(lifetime.value.runs.getRun(runRecord.id))).rejects.toMatchObject({
        code: 'READ_FAILED',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves a primary failure while attempting every failing release', async () => {
    const released: number[] = [];
    const primary = new Error('engine failed');

    const lifetime = await startPromiseStoreOwner((owner) =>
      Effect.gen(function* () {
        yield* owner.register(
          Effect.sync(() => {
            released.push(1);
          }).pipe(Effect.andThen(Effect.fail(new StoreError('WRITE_FAILED', 'first release')))),
        );
        yield* owner.register(
          Effect.sync(() => {
            released.push(2);
          }).pipe(Effect.andThen(Effect.fail(new StoreError('WRITE_FAILED', 'second release')))),
        );
      }),
    );

    await expect(lifetime.finish(Exit.fail(primary))).rejects.toBe(primary);
    expect(released).toEqual([2, 1]);
    expect(primary).toHaveProperty('effectCause');
  });

  it('surfaces release failure after parent success without an unhandled rejection', async () => {
    const lifetime = await startPromiseStoreOwner((owner) =>
      owner.register(Effect.fail(new StoreError('WRITE_FAILED', 'close failed'))),
    );

    await expect(lifetime.finish()).rejects.toMatchObject({
      code: 'WRITE_FAILED',
      cause: { primary: { _tag: 'Success' } },
    });
  });
});
