import type { SqliteHandle } from './database.js';
import { migrations } from './migrations/index.js';
import { StoreError } from './types.js';

const createMigrationTableSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

const readAppliedVersions = async (handle: SqliteHandle): Promise<number[]> => {
  const rows = await handle.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  return rows.map((row) => Number(Reflect.get(row as object, 'version')));
};

/**
 * Applies each numbered SQL migration atomically and rejects databases from newer attest versions
 * (PLAN 1S.2).
 */
const migrateToLatest = async (handle: SqliteHandle): Promise<void> => {
  await handle.exec(createMigrationTableSql);
  const appliedVersions = await readAppliedVersions(handle);
  const latestKnownVersion = migrations.at(-1)?.version ?? 0;
  const newestAppliedVersion = appliedVersions.at(-1) ?? 0;

  if (newestAppliedVersion > latestKnownVersion) {
    throw new StoreError(
      'SCHEMA_TOO_NEW',
      `Run store schema version ${newestAppliedVersion} is newer than supported version ${latestKnownVersion}; upgrade attest to open it.`,
    );
  }

  for (const migration of migrations) {
    await handle.begin();
    try {
      // Another opener may have applied this version before our SQLite write lock was acquired.
      const lockedAppliedVersions = await readAppliedVersions(handle);
      if (!lockedAppliedVersions.includes(migration.version)) {
        await handle.exec(migration.sql);
        await handle
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
      }
    } catch (error) {
      await handle.rollback();
      throw error;
    }

    await handle.commit();
  }
};

export { migrateToLatest };
