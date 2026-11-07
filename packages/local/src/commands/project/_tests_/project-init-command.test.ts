import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Deferred from 'effect/Deferred';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  const root = await mkdtemp(join(tmpdir(), 'attest-init-native-'));
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
  it('rolls back publication and a new directory on registry failure, preserving its code', async () => {
    const options = await fixture();
    await writeFile(join(options.workingDirectory, 'blocked'), 'not a directory');
    await expect(
      Effect.runPromiseExit(
        runProjectInitCommand({
          ...options,
          registryPath: join(options.workingDirectory, 'blocked', 'projects.json'),
        }),
      ).then(valueFromExit),
    ).rejects.toMatchObject({ code: 'registry_write_failed' });
    expect(await readdir(options.workingDirectory)).toEqual(['blocked']);
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
