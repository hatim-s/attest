import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoreError } from '@attest/core';
import { expect, it } from 'vitest';
import { run } from '../../../store/_tests_/store-fixture.js';
import { StoreCleanup } from '../../../store/internal/store-effect.js';
import { withReadCleanup } from '../../../store/internal/read-cleanup.js';
import { captureRunStoreSnapshot, removeRunStoreSnapshot } from '../run-store-snapshot.js';

it('attempts every release and retains all failures beside a primary typed error', async () => {
  const primary = new StoreError('RUN_NOT_FOUND', 'missing');
  const attempted: number[] = [];

  const exit = await run(
    Effect.exit(
      withReadCleanup(Effect.fail(primary), () => [
        Effect.sync(() => {
          attempted.push(1);
        }).pipe(Effect.andThen(Effect.die('close defect'))),
        Effect.sync(() => {
          attempted.push(2);
        }).pipe(Effect.andThen(Effect.fail('remove failure'))),
      ]),
    ),
  );

  expect(attempted).toEqual([1, 2]);
  expect(Exit.isFailure(exit)).toBe(true);

  if (Exit.isFailure(exit)) {
    expect(
      exit.cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error === primary),
    ).toBe(true);
    expect(
      Context.getOrUndefined(Cause.annotations(exit.cause), StoreCleanup)?.reasons,
    ).toHaveLength(2);
  }
});

it('preserves a primary defect and interruption when cleanup fails', async () => {
  for (const primary of [Effect.die('primary defect'), Effect.interrupt]) {
    const exit = await run(
      Effect.exit(withReadCleanup(primary, () => [Effect.fail('close failure')])),
    );

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(Context.getOrUndefined(Cause.annotations(exit.cause), StoreCleanup)).toBeDefined();
    }
  }
});

it('fails successful reads when close cannot be confirmed', async () => {
  await expect(
    run(withReadCleanup(Effect.succeed('read completed'), () => [Effect.fail('close failed')])),
  ).rejects.toMatchObject({ code: 'READ_FAILED' });
});

it('rejects an anchor whose pathname now identifies another inode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-inode-fence-'));
  const path = join(root, 'runs.db');
  await writeFile(path, 'old source');
  const source = await open(path, 'r');

  try {
    await rename(path, join(root, 'old.db'));
    await writeFile(path, 'replacement source');
    await expect(run(captureRunStoreSnapshot(path, source))).rejects.toThrow('Run store changed');
    expect(await readFile(path, 'utf8')).toBe('replacement source');
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('retries a real version change and hands off only the stable copied bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-version-change-'));
  const path = join(root, 'runs.db');
  await writeFile(path, 'before');
  const source = await open(path, 'r+');
  const stat = source.stat.bind(source);
  let calls = 0;
  Object.defineProperty(source, 'stat', {
    value: async () => {
      const metadata = await stat({ bigint: true });

      if (++calls === 1) await writeFile(path, 'after version changed');

      return metadata;
    },
  });

  try {
    const snapshot = await run(captureRunStoreSnapshot(path, source));

    try {
      expect(calls).toBe(4);
      expect(await readFile(snapshot.path, 'utf8')).toBe('after version changed');
    } finally {
      await run(removeRunStoreSnapshot(snapshot));
    }
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('retains cleanup evidence from nested brackets when another release fails', async () => {
  const exit = await run(
    Effect.exit(
      withReadCleanup(
        withReadCleanup(Effect.fail(new StoreError('RUN_NOT_FOUND', 'missing')), () => [
          Effect.fail('inner close'),
        ]),
        () => [Effect.fail('outer descriptor')],
      ),
    ),
  );

  expect(Exit.isFailure(exit)).toBe(true);

  if (Exit.isFailure(exit)) {
    expect(
      Context.getOrUndefined(Cause.annotations(exit.cause), StoreCleanup)?.reasons,
    ).toHaveLength(2);
  }
});
