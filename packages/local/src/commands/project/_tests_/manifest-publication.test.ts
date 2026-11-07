import * as Effect from 'effect/Effect';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { publishProjectManifest, rollbackPublishedManifest } from '../manifest-publish.js';

it('never overwrites a competing manifest and removes its unpublished temporary file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-native-publication-'));

  try {
    await writeFile(join(root, 'attest.project.json'), 'competing initializer');
    const exit = await Effect.runPromiseExit(publishProjectManifest(root, 'our candidate'));

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isSuccess(exit)) throw new Error('Publication unexpectedly succeeded.');

    expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toMatchObject({
      code: 'init_conflict',
    });
    expect(await readFile(join(root, 'attest.project.json'), 'utf8')).toBe('competing initializer');
    expect(await readdir(root)).toEqual(['attest.project.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('publishes atomically and refuses to roll back a changed manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-native-publication-'));

  try {
    const publication = await Effect.runPromiseExit(publishProjectManifest(root, 'our candidate'));

    expect(Exit.isSuccess(publication)).toBe(true);
    await writeFile(join(root, 'attest.project.json'), 'later publication');
    const rollback = await Effect.runPromiseExit(rollbackPublishedManifest(root, 'our candidate'));

    expect(Exit.isFailure(rollback)).toBe(true);

    if (Exit.isSuccess(rollback)) throw new Error('Rollback unexpectedly succeeded.');

    expect(rollback.cause.reasons.find(Cause.isFailReason)?.error).toMatchObject({
      code: 'project_recovery_required',
    });
    expect(await readFile(join(root, 'attest.project.json'), 'utf8')).toBe('later publication');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves a changed manifest when publication compensation follows a temporary unlink failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-native-publication-'));
  const originalUnlink = fs.unlink;

  const unlink = vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
    if (String(path).endsWith('.tmp')) {
      await writeFile(join(root, 'attest.project.json'), 'later publication');
      throw new Error('injected temporary unlink failure');
    }

    return originalUnlink(path);
  });

  try {
    const exit = await Effect.runPromiseExit(publishProjectManifest(root, 'our candidate'));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await readFile(join(root, 'attest.project.json'), 'utf8')).toBe('later publication');
  } finally {
    unlink.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
