import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { openBunSqliteHandle } from '../internal/bun-sqlite-handle.js';

it.skipIf(process.versions.bun === undefined)(
  'releases single-use Bun statements and checkpoints before a standalone copy',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-bun-statements-'));
    const path = join(directory, 'runs.db');
    const handle = await openBunSqliteHandle(path);

    try {
      await handle.exec('PRAGMA journal_mode=WAL; CREATE TABLE items (id INTEGER PRIMARY KEY)');

      for (let id = 0; id < 10000; id++) {
        await handle.prepare('INSERT INTO items VALUES (?)').run(id);
        expect(handle.activeStatementCount).toBe(0);
        expect(await handle.prepare('SELECT id FROM items WHERE id = ?').all(id)).toEqual([{ id }]);
        expect(handle.activeStatementCount).toBe(0);
      }

      await expect(handle.prepare('INSERT INTO items VALUES (?)').run(0)).rejects.toThrow();
      expect(handle.activeStatementCount).toBe(0);
      await expect(handle.prepare('SELECT abs(-9223372036854775808)').all()).rejects.toThrow();
      expect(handle.activeStatementCount).toBe(0);

      // Close must also release a prepared statement whose query never started.
      handle.prepare('SELECT * FROM items');
      expect(handle.activeStatementCount).toBe(1);
    } finally {
      await handle.close();
    }

    try {
      expect(handle.activeStatementCount).toBe(0);
      expect(await readdir(directory)).toEqual(['runs.db']);
      const snapshot = join(directory, 'snapshot.db');
      await copyFile(path, snapshot);
      const reader = await openBunSqliteHandle(snapshot, { readOnly: true });

      try {
        expect(await reader.prepare('SELECT count(*) AS count FROM items').all()).toEqual([
          { count: 10000 },
        ]);
      } finally {
        await reader.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
