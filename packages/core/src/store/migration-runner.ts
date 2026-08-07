import type { SqliteHandle } from './internal/sqlite-handle.js';
import { migrations } from './migrations/registry.js';
import { StoreError } from './types.js';

interface MigrationVersionRow {
  version: number;
}

const createMigrationTableSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

const readAppliedVersions = async (handle: SqliteHandle): Promise<number[]> => {
  const rows = (await handle
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()) as MigrationVersionRow[];
  return rows.map((row) => Number(row.version));
};

/** Verifies an existing store schema without creating tables or applying migrations. */
const validateReadableSchema = async (handle: SqliteHandle): Promise<void> => {
  const latestKnownVersion = migrations.at(-1)?.version ?? 0;
  let appliedVersions: number[];
  try {
    appliedVersions = await readAppliedVersions(handle);
  } catch (error) {
    throw new StoreError(
      'SCHEMA_OUTDATED',
      'Run store schema is missing or unreadable; open it with a compatible attest writer first.',
      { cause: error },
    );
  }
  const newestAppliedVersion = appliedVersions.at(-1) ?? 0;
  if (newestAppliedVersion > latestKnownVersion) {
    throw new StoreError(
      'SCHEMA_TOO_NEW',
      `Run store schema version ${newestAppliedVersion} is newer than supported version ${latestKnownVersion}; upgrade attest to open it.`,
    );
  }
  const knownVersions = migrations.map((migration) => migration.version);
  if (
    appliedVersions.length !== knownVersions.length ||
    appliedVersions.some((version, index) => version !== knownVersions[index])
  ) {
    throw new StoreError(
      'SCHEMA_OUTDATED',
      `Run store schema version ${newestAppliedVersion} is older than supported version ${latestKnownVersion}; open it with a compatible attest writer first.`,
    );
  }
};

/** Applies numbered SQL atomically and rejects databases from newer attest versions (PLAN 1S.2). */
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
      await handle.commit();
    } catch (error) {
      await handle.rollback();
      throw error;
    }
  }
};

export { migrateToLatest, validateReadableSchema };
