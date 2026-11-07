import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';

import { StoreError } from '@attest/core';

import { openLibsqlHandle } from './libsql-handle.js';
import { openNodeSqliteHandle } from './node-sqlite-handle.js';
import type { SqliteHandle } from './sqlite-handle.js';
import { finishStoreCleanup, storeCall } from './store-effect.js';

/** Applies durability settings before transferring the handle to its owning store. */
const applyPragmas = Effect.fn('store.applyPragmas')(function* (handle: SqliteHandle) {
  for (const pragma of [
    'PRAGMA busy_timeout=5000',
    'PRAGMA journal_mode=WAL',
    'PRAGMA foreign_keys=ON',
    'PRAGMA synchronous=NORMAL',
  ]) {
    yield* storeCall('WRITE_FAILED', 'Could not configure the run store.', () =>
      handle.exec(pragma),
    );
  }
});

/**
 * Transfers a configured driver handle. Failed setup closes before returning, preserving the
 * setup failure and any cleanup evidence. Masking joins uncooperative driver promises.
 */
const openSqliteHandle = Effect.fn('store.openSqliteHandle')(function* (path: string) {
  const nodeHandle = yield* storeCall('WRITE_FAILED', 'Could not open the run store.', () =>
    openNodeSqliteHandle(path),
  );

  const handle =
    nodeHandle ??
    (yield* storeCall('WRITE_FAILED', 'Could not open the fallback run store.', () =>
      openLibsqlHandle(path),
    ));

  const configured = yield* Effect.exit(applyPragmas(handle));

  if (Exit.isFailure(configured)) {
    const cleanup = yield* Effect.exit(
      storeCall('WRITE_FAILED', 'Could not close the unconfigured run store.', () =>
        handle.close(),
      ),
    );

    yield* finishStoreCleanup(configured, cleanup);
  }

  return handle;
}, Effect.uninterruptible);

/**
 * Opens an existing database without migrations or a creating fallback. SQLite can create WAL
 * sidecars for a live writer. The receiving store owns this handle immediately after transfer.
 */
const openReadonlySqliteHandle = Effect.fn('store.openReadonlySqliteHandle')(function* (
  path: string,
) {
  const handle = yield* storeCall('READ_FAILED', 'Could not open the readonly run store.', () =>
    openNodeSqliteHandle(path, { readOnly: true }),
  );

  if (handle === undefined) {
    return yield* Effect.fail(
      new StoreError('READ_FAILED', 'Read-only run-store access requires node:sqlite support.'),
    );
  }

  return handle;
}, Effect.uninterruptible);

export { openReadonlySqliteHandle, openSqliteHandle };
