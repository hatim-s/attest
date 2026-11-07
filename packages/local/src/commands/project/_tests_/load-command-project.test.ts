import { valueFromExit } from '../../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
import { open, mkdtemp, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeFixtureProject } from '../../../_tests_/support/project-transaction.js';
import {
  acquireProjectLock,
  releaseProjectLock,
} from '../../../project/transaction/project-lock.js';
import { AnchoredCleanupFailure } from '../../../internal/open-anchored.js';
import { loadCommandProject } from '../load-command-project.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('loadCommandProject', () => {
  it('returns a stable lock conflict instead of observing a paused publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attest-load-command-project-'));
    temporaryDirectories.push(root);
    await writeFixtureProject(root);

    const lock = await Effect.runPromiseExit(acquireProjectLock(root)).then((exit) =>
      valueFromExit(exit),
    );

    try {
      await expect(
        Effect.runPromiseExit(loadCommandProject({ workingDirectory: root })).then((exit) =>
          valueFromExit(exit),
        ),
      ).rejects.toMatchObject({
        code: 'project_locked',
      });
    } finally {
      await Effect.runPromiseExit(releaseProjectLock(lock)).then((exit) => valueFromExit(exit));
    }
  });
});

it('retains failed read cleanup when a writer acquires the post-read lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-load-command-cleanup-'));
  temporaryDirectories.push(root);
  await writeFixtureProject(root);
  const probe = await open(join(root, 'attest.project.json'), 'r');
  // SAFETY: This is the prototype of the real descriptor used by the loader below.
  const prototype = Object.getPrototypeOf(probe) as Pick<FileHandle, 'readFile'>;
  await probe.close();
  const read = prototype.readFile;
  const closeFailure = new Error('Close acknowledgement failed.');
  let intercepted = false;
  let lock: Effect.Success<ReturnType<typeof acquireProjectLock>> | undefined;

  const spy = vi.spyOn(prototype, 'readFile').mockImplementation(function (
    this: FileHandle,
    ...args
  ) {
    if (!intercepted) {
      intercepted = true;
      const close = this.close.bind(this);
      this.close = async () => {
        await close();
        lock = valueFromExit(await Effect.runPromiseExit(acquireProjectLock(root)));
        throw closeFailure;
      };
    }

    return read.apply(this, args);
  });

  try {
    await expect(
      Effect.runPromiseExit(loadCommandProject({ workingDirectory: root })).then(valueFromExit),
    ).rejects.toBeInstanceOf(AnchoredCleanupFailure);
    expect(intercepted).toBe(true);
    expect(lock).toBeDefined();
  } finally {
    spy.mockRestore();

    if (lock) valueFromExit(await Effect.runPromiseExit(releaseProjectLock(lock)));
  }
});
