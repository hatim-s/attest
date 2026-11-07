import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cause, Effect, Exit } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import { PrivateFileFailure, readPrivateFile, writePrivateFile } from '../private-file.js';
import { EffectBoundaryFailure, valueFromExit } from '../effect-exit.js';

const roots: string[] = [];

/** Uses a resolved temporary root because macOS tmpdir may itself contain a symlink. */
const fixture = async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'attest-private-effect-'));
  roots.push(root);

  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('private filesystem Effect ownership', () => {
  it('keeps defects and interruption distinct from typed failures at Promise edges', async () => {
    const original = new Error('original failure');
    const typed = await Effect.runPromiseExit(Effect.fail(original));
    expect(() => valueFromExit(typed)).toThrow(original);
    expect(Object.getOwnPropertyDescriptor(original, 'effectCause')?.enumerable).toBe(false);

    const defect = await Effect.runPromiseExit(
      Effect.failCause(Cause.combine(Cause.fail(original), Cause.die('broken invariant'))),
    );

    expect(() => valueFromExit(defect)).toThrow(EffectBoundaryFailure);
    const interrupted = await Effect.runPromiseExit(Effect.failCause(Cause.interrupt()));
    expect(() => valueFromExit(interrupted)).toThrow(EffectBoundaryFailure);
  });
  it('joins an interrupted publication before reporting interruption and removing its sibling', async () => {
    const root = await fixture();
    const path = join(root, 'credentials');
    const text = 'x'.repeat(8 * 1024 * 1024);
    const controller = new AbortController();

    const pending = Effect.runPromiseExit(writePrivateFile(path, text), {
      signal: controller.signal,
    });

    controller.abort();
    const exit = await pending;

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(text);
    expect(await readdir(root)).toEqual(['credentials']);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('keeps ENOENT at the forward boundary and rejects a symlink without reading its target', async () => {
    const root = await fixture();
    const missing = await Effect.runPromiseExit(readPrivateFile(join(root, 'missing')));

    expect(() => valueFromExit(missing)).toThrow(PrivateFileFailure);
    expect(missing).toMatchObject({
      cause: {
        reasons: [{ error: { _tag: 'PrivateFileFailure', code: 'ENOENT', operation: 'open' } }],
      },
    });

    const target = join(root, 'target');
    await writeFile(target, 'secret', { mode: 0o600 });
    await symlink(target, join(root, 'link'));
    const linked = await Effect.runPromiseExit(readPrivateFile(join(root, 'link')));

    expect(Exit.isFailure(linked)).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('secret');
  });
});
