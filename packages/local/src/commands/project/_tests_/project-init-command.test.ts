import * as publication from '../manifest-publish.js';
import * as registry from '../../../registry/project-registry.js';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Deferred from 'effect/Deferred';
import { access, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashCanonicalContent } from '@attest/core';
import { AnchoredFileFailure } from '../../../internal/open-anchored.js';
import { ProjectLoadError } from '../../../project/project-errors.js';
import { LocalError } from '../../../errors/index.js';
import * as loader from '../../../project/project-loader/index.js';
import { valueFromExit } from '../../../internal/effect-exit.js';
import { runProjectInitCommand } from '../project-init-command.js';

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** Creates an isolated init target with a private registry path. */
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'attest-init-native-')));
  directories.push(root);

  return {
    directory: 'project',
    interactive: false,
    readStdin: () => Promise.resolve(''),
    registryPath: join(root, 'registry', 'projects.json'),
    workingDirectory: root,
  };
};

describe('native project initialization', () => {
  it('keeps the verified manifest on registry failure, preserving its code', async () => {
    const options = await fixture();
    await Effect.runPromise(runProjectInitCommand({ ...options, directory: 'control' }));
    expect(await readFile(options.registryPath, 'utf8')).toContain('control');
    await writeFile(join(options.workingDirectory, 'blocked'), 'not a directory');
    await expect(
      Effect.runPromiseExit(
        runProjectInitCommand({
          ...options,
          registryPath: join(options.workingDirectory, 'blocked', 'projects.json'),
        }),
      ).then(valueFromExit),
    ).rejects.toMatchObject({ code: 'registry_write_failed' });
    await expect(
      readFile(join(options.workingDirectory, 'project', 'attest.project.json'), 'utf8'),
    ).resolves.toContain('attest.project');
  });

  it('B1 preserves the base recovery error when rollback cannot remove changed bytes', async () => {
    const options = await fixture();
    const path = join(options.workingDirectory, 'project', 'attest.project.json');
    const primary = new ProjectLoadError('project_invalid', 'Verification failed.', []);
    vi.spyOn(loader, 'loadProject').mockImplementation(() =>
      Effect.andThen(
        Effect.promise(() => writeFile(path, '{"changed":true}')),
        Effect.fail(primary),
      ),
    );

    const error = await Effect.runPromiseExit(runProjectInitCommand(options))
      .then(valueFromExit)
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject(
      new LocalError(
        'project_recovery_required',
        'Initialization failed and the published manifest could not be rolled back.',
        { path, hint: 'Preserve the manifest and reconcile it before retrying.' },
      ),
    );

    if (!(error instanceof LocalError) || !Cause.isCause(error.cause))
      throw new Error('Expected the primary and rollback Causes.');
    expect(
      error.cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error === primary),
    ).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('{"changed":true}');
  });

  it('B2 preserves the complete base init envelope for a non-LocalError load failure', async () => {
    const options = await fixture();
    const root = join(options.workingDirectory, 'project');
    let stagedHash = '';
    vi.spyOn(loader, 'loadProject').mockImplementation(() =>
      Effect.andThen(
        Effect.promise(async () => {
          stagedHash = hashCanonicalContent(
            await readFile(join(root, 'attest.project.json'), 'utf8'),
          );
        }),
        Effect.fail(
          new AnchoredFileFailure({
            operation: 'open',
            path: root,
            code: 'EIO',
            cause: new Error('private path'),
          }),
        ),
      ),
    );

    const error = await Effect.runPromiseExit(runProjectInitCommand(options))
      .then(valueFromExit)
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject(
      new LocalError('init_failed', 'Could not initialize the Attest project.', {
        path: root,
        hint: 'Check the target permissions and retry in an uninitialized directory.',
        details: { staged_content_hash: stagedHash },
      }),
    );
    expect(stagedHash).not.toBe('');
    expect(await readdir(options.workingDirectory)).toEqual([]);
  });

  it.each(['load', 'publish', 'register', 'rollback'] as const)(
    'keeps the base %s defect envelope',
    async (step) => {
      const options = await fixture();
      const defect = new Error('private module defect');

      if (step === 'load') vi.spyOn(loader, 'loadProject').mockReturnValue(Effect.die(defect));

      if (step === 'publish')
        vi.spyOn(publication, 'publishProjectManifest').mockReturnValue(Effect.die(defect));

      if (step === 'register')
        vi.spyOn(registry, 'registerProject').mockReturnValue(Effect.die(defect));

      if (step === 'rollback') {
        vi.spyOn(loader, 'loadProject').mockReturnValue(
          Effect.fail(new ProjectLoadError('project_invalid', 'failed', [])),
        );
        vi.spyOn(publication, 'rollbackPublishedManifest').mockReturnValue(Effect.die(defect));
      }

      const error = await Effect.runPromiseExit(runProjectInitCommand(options))
        .then(valueFromExit)
        .catch((cause: unknown) => cause);

      expect(error).toMatchObject({
        code:
          step === 'rollback'
            ? 'project_recovery_required'
            : step === 'register'
              ? 'registry_write_failed'
              : 'init_failed',
        hint:
          step === 'rollback'
            ? 'Preserve the manifest and reconcile it before retrying.'
            : step === 'register'
              ? `Run \`attest projects add ${join(options.workingDirectory, 'project')}\` to register it.`
              : 'Check the target permissions and retry in an uninitialized directory.',
        path:
          step === 'register'
            ? options.registryPath
            : join(
                options.workingDirectory,
                'project',
                ...(step === 'rollback' ? ['attest.project.json'] : []),
              ),
      });

      if (step === 'rollback')
        expect(error).toMatchObject({
          hint: 'Preserve the manifest and reconcile it before retrying.',
        });
    },
  );

  it('preserves a rejected prompt for generic CLI serialization', async () => {
    const options = await fixture();
    const failure = new Error('private prompt failure');
    await expect(
      Effect.runPromiseExit(
        runProjectInitCommand({
          ...options,
          interactive: true,
          prompt: () => Promise.reject(failure),
        }),
      ).then(valueFromExit),
    ).rejects.toBe(failure);
  });

  it('rolls back on interruption during verification without registering', async () => {
    const options = await fixture();
    const entered = Deferred.makeUnsafe<void>();
    vi.spyOn(loader, 'loadProject').mockImplementation(() =>
      Effect.andThen(Deferred.succeed(entered, undefined), Effect.never),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(runProjectInitCommand(options));
        yield* Deferred.await(entered);
        expect(
          yield* Effect.promise(() =>
            readFile(join(options.workingDirectory, 'project', 'attest.project.json'), 'utf8'),
          ),
        ).toContain('attest.project');
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );
    expect(await readdir(options.workingDirectory)).toEqual([]);
    await expect(access(options.registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
