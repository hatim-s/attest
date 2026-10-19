import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { collectArtifacts } from '../node.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const workspaceWith = async (files: Record<string, string | Buffer>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'attest-client-collect-'));

  directories.push(root);

  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }

  return root;
};

describe('collectArtifacts', () => {
  it('inlines text as utf8 and other bytes as base64 with root-relative paths', async () => {
    const root = await workspaceWith({
      'src/answer.ts': 'export const answer = 42;\n',
      'image.bin': Buffer.from([0xff, 0xfe, 0x00, 0x01]),
    });

    expect(await collectArtifacts(root)).toEqual({
      artifacts: [
        {
          kind: 'inline',
          path: 'image.bin',
          media_type: 'application/octet-stream',
          encoding: 'base64',
          content: '//4AAQ==',
        },
        {
          kind: 'inline',
          path: 'src/answer.ts',
          media_type: 'text/typescript',
          encoding: 'utf8',
          content: 'export const answer = 42;\n',
        },
      ],
      skipped: [],
    });
  });

  it('skips files past the caps, invalid names and symlinks out of the root', async () => {
    const outside = await workspaceWith({ 'secret.txt': 'do not collect' });

    const root = await workspaceWith({
      'a.txt': 'aaaa',
      'b.txt': 'bbbb',
      'c.txt': 'cccc',
      'back\\slash.txt': 'x',
    });

    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));

    const byCount = await collectArtifacts(root, { maxCount: 1 });

    expect(byCount.artifacts.map((artifact) => artifact.path)).toEqual(['a.txt']);
    expect(byCount.skipped).toEqual([
      { path: 'b.txt', reason: 'max_count' },
      { path: 'back\\slash.txt', reason: 'invalid_path' },
      { path: 'c.txt', reason: 'max_count' },
    ]);

    const byBytes = await collectArtifacts(root, { maxBytes: 8 });

    expect(byBytes.artifacts.map((artifact) => artifact.path)).toEqual(['a.txt', 'b.txt']);
    expect(byBytes.skipped).toContainEqual({ path: 'c.txt', reason: 'max_bytes' });
  });
});
