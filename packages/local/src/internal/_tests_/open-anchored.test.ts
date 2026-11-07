import { mkdtemp, realpath, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import { afterEach, expect, it } from 'vitest';

import {
  AnchoredCleanup,
  AnchoredCleanupFailure,
  anchoredCall,
  withAnchored,
} from '../open-anchored.js';

const roots: string[] = [];

/** Uses a real temporary root so macOS aliases do not affect containment. */
const fixture = async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'attest-anchored-'));
  roots.push(root);
  const path = join(root, 'source.json');
  await writeFile(path, '{}');

  return { root, path };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Closes the real descriptor before injecting a close acknowledgement failure. */
const failClose = (handle: FileHandle) => {
  const close = handle.close.bind(handle);
  handle.close = async () => {
    await close();
    throw new Error('close acknowledgement failed');
  };
};

it('fails a successful read when descriptor close fails', async () => {
  const { root, path } = await fixture();

  const exit = await Effect.runPromiseExit(
    withAnchored(path, { root, kind: 'file' }, ({ handle }) => {
      failClose(handle);

      return anchoredCall('readFile', path, () => handle.readFile('utf8'));
    }),
  );

  expect(Exit.isFailure(exit)).toBe(true);

  if (Exit.isFailure(exit))
    expect(
      exit.cause.reasons.some(
        (reason) => Cause.isFailReason(reason) && reason.error instanceof AnchoredCleanupFailure,
      ),
    ).toBe(true);
});

it('retains primary failure and defect causes with cleanup evidence', async () => {
  const { root, path } = await fixture();
  const original = new Error('primary');

  for (const primary of [Effect.fail(original), Effect.die(original)]) {
    const exit = await Effect.runPromiseExit(
      withAnchored(path, { root, kind: 'file' }, ({ handle }) => {
        failClose(handle);

        return primary;
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isFailure(exit)) {
      expect(
        exit.cause.reasons.some((reason) =>
          Cause.isFailReason(reason)
            ? reason.error === original
            : Cause.isDieReason(reason) && reason.defect === original,
        ),
      ).toBe(true);
      expect(
        Context.getOrUndefined(Cause.annotations(exit.cause), AnchoredCleanup) !== undefined,
      ).toBe(true);
    }
  }
});

it('joins a pending foreign read before closing on interruption', async () => {
  const { root, path } = await fixture();
  let finish!: () => void;
  let entered!: () => void;

  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const controller = new AbortController();
  let descriptor: FileHandle | undefined;

  const running = Effect.runPromiseExit(
    withAnchored(path, { root, kind: 'file' }, ({ handle }) => {
      descriptor = handle;

      return anchoredCall('readFile', path, async () => {
        entered();
        await gate;

        return handle.readFile('utf8');
      });
    }),
    { signal: controller.signal },
  );

  await started;
  controller.abort();
  expect(await descriptor?.stat()).toBeDefined();
  finish();
  const exit = await running;
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  await expect(descriptor?.stat()).rejects.toMatchObject({ code: 'EBADF' });
});
