import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadExplicitUploads,
  publishTerminalArtifacts,
  resolveArtifactDestination,
  resolveRemotePath,
  SANDBOX_WORKSPACE,
} from '../files.js';
import type { VercelSandboxSdk } from '../types.js';

const temporaryDirectories: string[] = [];

/** Creates one owned test directory and schedules its removal. */
const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-sandbox-files-'));
  temporaryDirectories.push(directory);
  return directory;
};

/** Creates the narrow SDK mock used by artifact transfer tests. */
const createSandbox = (
  content: string,
  symbolicLinks: ReadonlySet<string> = new Set(),
): VercelSandboxSdk =>
  ({
    readFile: vi.fn(() => Promise.resolve(Readable.from([Buffer.from(content)]))),
    runCommand: vi.fn(({ args }: { args: string[] }) =>
      Promise.resolve({
        exitCode: args[0] === '-L' ? (symbolicLinks.has(args[1]!) ? 0 : 1) : 0,
      }),
    ),
    stop: vi.fn(),
    writeFiles: vi.fn(),
  }) as unknown as VercelSandboxSdk;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('sandbox file transfers', () => {
  it('resolves literal relative paths below the fixed remote workspace', () => {
    expect(resolveRemotePath('inputs/case.json')).toBe(`${SANDBOX_WORKSPACE}/inputs/case.json`);
    for (const path of ['', '/tmp/file', '../file', 'inputs/*.json', 'inputs/{a,b}.json']) {
      expect(() => resolveRemotePath(path), path).toThrow(TypeError);
    }
    expect(() => resolveArtifactDestination('/tmp/artifacts', '../outside')).toThrow(TypeError);
    expect(() => resolveArtifactDestination('/tmp/artifacts', 'reports/*.json')).toThrow(TypeError);
  });

  it('loads contained regular uploads and rejects symlinked paths and aggregate overflow', async () => {
    const projectRoot = await createTemporaryDirectory();
    await mkdir(join(projectRoot, 'inputs'));
    await writeFile(join(projectRoot, 'inputs', 'a.txt'), 'abc');
    await writeFile(join(projectRoot, 'inputs', 'b.txt'), 'def');

    await expect(
      loadExplicitUploads(
        projectRoot,
        [{ source: 'inputs/a.txt', destination: 'payload/a.txt', mode: 0o600 }],
        3,
      ),
    ).resolves.toEqual([
      { path: `${SANDBOX_WORKSPACE}/payload/a.txt`, content: Buffer.from('abc'), mode: 0o600 },
    ]);
    await expect(
      loadExplicitUploads(
        projectRoot,
        [
          { source: 'inputs/a.txt', destination: 'a.txt' },
          { source: 'inputs/b.txt', destination: 'b.txt' },
        ],
        5,
      ),
    ).rejects.toMatchObject({ code: 'output_cap_exceeded' });

    await symlink(join(projectRoot, 'inputs'), join(projectRoot, 'linked-inputs'));
    await symlink(join(projectRoot, 'inputs', 'a.txt'), join(projectRoot, 'linked-file'));
    for (const source of ['linked-inputs/a.txt', 'linked-file']) {
      await expect(
        loadExplicitUploads(projectRoot, [{ source, destination: 'payload.txt' }], 16),
      ).rejects.toThrow(/symbolic link/u);
    }
  });

  it('streams regular artifacts into contained host destinations', async () => {
    const projectRoot = await createTemporaryDirectory();
    const artifactRoot = join(projectRoot, 'artifacts');
    const sandbox = createSandbox('artifact');

    await publishTerminalArtifacts(
      sandbox,
      [{ source: 'results/report.json', destination: 'case/report.json' }],
      projectRoot,
      artifactRoot,
      32,
      1_000,
      new AbortController().signal,
    );

    await expect(readFile(join(artifactRoot, 'case/report.json'), 'utf8')).resolves.toBe(
      'artifact',
    );
    expect(sandbox.readFile).toHaveBeenCalledWith(
      { path: `${SANDBOX_WORKSPACE}/results/report.json` },
      expect.any(Object),
    );
  });

  it('rejects remote parent symlinks, oversized streams, and symlinked host parents', async () => {
    const projectRoot = await createTemporaryDirectory();
    const artifactRoot = join(projectRoot, 'artifacts');
    const remoteParent = `${SANDBOX_WORKSPACE}/results`;

    await expect(
      publishTerminalArtifacts(
        createSandbox('artifact', new Set([remoteParent])),
        [{ source: 'results/report.json', destination: 'report.json' }],
        projectRoot,
        artifactRoot,
        32,
        1_000,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/symbolic link/u);

    await expect(
      publishTerminalArtifacts(
        createSandbox('too large'),
        [{ source: 'report.json', destination: 'report.json' }],
        projectRoot,
        artifactRoot,
        3,
        1_000,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'output_cap_exceeded' });

    const outside = await createTemporaryDirectory();
    await mkdir(artifactRoot);
    await symlink(outside, join(artifactRoot, 'linked'));
    await expect(
      publishTerminalArtifacts(
        createSandbox('artifact'),
        [{ source: 'report.json', destination: 'linked/report.json' }],
        projectRoot,
        artifactRoot,
        32,
        1_000,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/symbolic link/u);
  });
});
