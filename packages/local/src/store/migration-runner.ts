import { stripStruct } from '@attest/contracts';
import { parseWithSchemaSync } from '@attest/contracts';
import * as Schema from 'effect/Schema';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { StoreError } from '@attest/core';

import type { SqliteHandle } from './internal/sqlite-handle.js';
import { migrations } from './migrations/registry.js';
import { storeCall, storeDecode, finishStoreCleanup } from './internal/store-effect.js';

const createMigrationTableSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

/** Reads and validates the driver's schema version projection. */
const readAppliedVersions = Effect.fn('store.readAppliedVersions')(function* (
  handle: SqliteHandle,
) {
  const rows = yield* storeCall('READ_FAILED', 'Could not read schema migrations.', () =>
    handle.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
  );

  return yield* storeDecode('Schema migration versions are unreadable.', () =>
    parseWithSchemaSync(Schema.Array(stripStruct({ version: Schema.Finite })), rows).map((row) =>
      Number(row.version),
    ),
  );
});

/** Verifies an existing store schema without creating tables or applying migrations. */
const validateReadableSchema = Effect.fn('store.validateReadableSchema')(function* (
  handle: SqliteHandle,
) {
  const latestKnownVersion = migrations.at(-1)?.version ?? 0;

  const appliedVersions = yield* readAppliedVersions(handle).pipe(
    Effect.mapError(
      (cause) =>
        new StoreError(
          'SCHEMA_OUTDATED',
          'Run store schema is missing or unreadable; open it with a compatible attest writer first.',
          { cause },
        ),
    ),
  );

  const newestAppliedVersion = appliedVersions.at(-1) ?? 0;

  if (newestAppliedVersion > latestKnownVersion) {
    return yield* Effect.fail(
      new StoreError(
        'SCHEMA_TOO_NEW',
        `Run store schema version ${newestAppliedVersion} is newer than supported version ${latestKnownVersion}; upgrade attest to open it.`,
      ),
    );
  }

  const knownVersions = migrations.map((migration) => migration.version);

  if (
    appliedVersions.length !== knownVersions.length ||
    appliedVersions.some((version, index) => version !== knownVersions[index])
  ) {
    return yield* Effect.fail(
      new StoreError(
        'SCHEMA_OUTDATED',
        `Run store schema version ${newestAppliedVersion} is older than supported version ${latestKnownVersion}; open it with a compatible attest writer first.`,
      ),
    );
  }
});

/** Applies numbered SQL atomically and rejects databases from newer attest versions. */
const migrateToLatest = Effect.fn('store.migrateToLatest')(function* (handle: SqliteHandle) {
  yield* storeCall('WRITE_FAILED', 'Could not create the migration table.', () =>
    handle.exec(createMigrationTableSql),
  );
  const appliedVersions = yield* readAppliedVersions(handle);
  const latestKnownVersion = migrations.at(-1)?.version ?? 0;
  const newestAppliedVersion = appliedVersions.at(-1) ?? 0;

  if (newestAppliedVersion > latestKnownVersion) {
    return yield* Effect.fail(
      new StoreError(
        'SCHEMA_TOO_NEW',
        `Run store schema version ${newestAppliedVersion} is newer than supported version ${latestKnownVersion}; upgrade attest to open it.`,
      ),
    );
  }

  for (const migration of migrations) {
    yield* storeCall('WRITE_FAILED', 'Could not begin the schema migration.', () => handle.begin());

    const primary = yield* Effect.exit(
      Effect.gen(function* () {
        // Recheck under the SQLite write lock, since another opener may have migrated first.
        const lockedAppliedVersions = yield* readAppliedVersions(handle);

        if ((lockedAppliedVersions.at(-1) ?? 0) > latestKnownVersion)
          return yield* Effect.fail(
            new StoreError('SCHEMA_TOO_NEW', 'A newer writer migrated this store; upgrade attest.'),
          );

        if (!lockedAppliedVersions.includes(migration.version)) {
          yield* storeCall('WRITE_FAILED', 'Could not apply the schema migration.', () =>
            handle.exec(migration.sql),
          );

          if ('backfill' in migration)
            yield* storeCall('WRITE_FAILED', 'Could not backfill dashboard totals.', () =>
              migration.backfill(handle),
            );

          if ('afterSql' in migration)
            yield* storeCall('WRITE_FAILED', 'Could not create dashboard indexes.', () =>
              handle.exec(migration.afterSql),
            );
          yield* storeCall('WRITE_FAILED', 'Could not record the schema migration.', () =>
            handle
              .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
              .run(migration.version, migration.name, new Date().toISOString()),
          );
        }

        yield* storeCall('WRITE_FAILED', 'Could not commit the schema migration.', () =>
          handle.commit(),
        );
      }),
    );

    if (Exit.isFailure(primary)) {
      const rollback = yield* Effect.exit(
        storeCall('WRITE_FAILED', 'Could not roll back the schema migration.', () =>
          handle.rollback(),
        ),
      );

      yield* finishStoreCleanup(primary, rollback);
    }
  }
}, Effect.uninterruptible);

export { migrateToLatest, validateReadableSchema };
