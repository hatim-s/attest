import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Schema from 'effect/Schema';
import { stripStruct, parseWithSchema } from '@attest/contracts';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, unlink, realpath, lstat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { resolveContainedPath } from '../project-path.js';
import { isProcessPresent } from '../../internal/process-presence.js';
import { syncPath } from '../../internal/sync-path.js';
import {
  anchoredCall,
  withAnchored,
  AnchoredCleanup,
  type AnchoredFileFailure,
  type AnchoredCleanupFailure,
} from '../../internal/open-anchored.js';
import { ProjectTransactionError } from './project-transaction-error.js';

type ProjectLockFailure = AnchoredFileFailure | AnchoredCleanupFailure | ProjectTransactionError;

/** Per-operation diagnostic annotation, retaining release uncertainty on primary Causes. */
class ProjectLockCleanup extends Context.Service<ProjectLockCleanup, Cause.Cause<Error>>()(
  'attest/ProjectLockCleanup',
) {}

/** Accumulates nested cleanup evidence instead of replacing an earlier diagnostic. */
const annotateProjectCleanup = <E>(primary: Cause.Cause<E>, cleanup: Cause.Cause<Error>) =>
  Cause.annotate(
    primary,
    Context.make(
      ProjectLockCleanup,
      Cause.combine(
        Context.getOrUndefined(Cause.annotations(primary), ProjectLockCleanup) ?? Cause.empty,
        cleanup,
      ),
    ),
  );

const PROJECT_LOCK_FILE = '.attest/project.lock';

const PROJECT_LOCK_SCHEMA = 'attest.project-lock';

const execFileAsync = promisify(execFile);

/** The lock file's contents: who owns the project mutation lock and how to prove it is stale. */
const projectLockSchema = stripStruct({
  created_at: Schema.String,
  hostname: Schema.String,
  owner_token: Schema.String,
  pid: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
  ).check(Schema.isGreaterThan(0)),
  process_start_identity: Schema.NullOr(Schema.String),
  schema: Schema.Literal(PROJECT_LOCK_SCHEMA),
});

type ProjectLockMetadata = typeof projectLockSchema.Type;

type ProjectLockInspection =
  | { state: 'absent' }
  | { raw: string; reason: string; state: 'invalid' }
  | {
      metadata: ProjectLockMetadata;
      raw: string;
      reason: string;
      state: 'live' | 'stale' | 'unknown';
    };

type ProjectLockHandle = {
  metadata: ProjectLockMetadata;
  identity: { dev: bigint; ino: bigint };
  path: string;
  root: string;
};

/** Reads the kernel-observed start identity; unavailable ps does not prove absence. */
const getProcessStartIdentity = Effect.fn('getProcessStartIdentity')(function* (pid: number) {
  return yield* anchoredCall('ps', String(pid), () =>
    execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }),
  ).pipe(
    Effect.map(({ stdout }) => stdout.trim() || null),
    Effect.catch(() => Effect.succeed(null)),
  );
});

const parseLockMetadata = (raw: string): ProjectLockMetadata | undefined => {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const parsed = parseWithSchema(projectLockSchema, value);

  return parsed.ok ? parsed.value : undefined;
};

/** Inspects an anchored inode and never steals an existing lock. */
const inspectProjectLock = Effect.fn('inspectProjectLock')(function* (
  root: string,
): Effect.fn.Return<ProjectLockInspection, ProjectLockFailure> {
  const path = yield* resolveContainedPath(root, PROJECT_LOCK_FILE, {
    expect: 'file',
    problem: () =>
      new ProjectTransactionError('project_invalid', 'Unsafe project lock path.', {
        path: PROJECT_LOCK_FILE,
      }),
  });

  const resolvedRoot = yield* anchoredCall('realpath', root, () => realpath(root));

  const read = yield* Effect.exit(
    withAnchored(path, { kind: 'file', root: resolvedRoot }, ({ handle }) =>
      anchoredCall('readFile', path, () => handle.readFile('utf8')),
    ),
  );

  if (Exit.isFailure(read)) {
    const reason = read.cause.reasons.find(Cause.isFailReason);
    const cleanup = Context.getOrUndefined(Cause.annotations(read.cause), AnchoredCleanup);

    if (
      !Cause.hasDies(read.cause) &&
      !Cause.hasInterrupts(read.cause) &&
      cleanup === undefined &&
      reason &&
      'code' in reason.error &&
      reason.error.code === 'ENOENT'
    )
      return { state: 'absent' };

    return yield* Effect.failCause(
      Cause.map(
        read.cause,
        (cause) =>
          new ProjectTransactionError('project_locked', 'Could not inspect the project lock.', {
            path: PROJECT_LOCK_FILE,
            details: { lock_state: 'unreadable' },
            cause,
          }),
      ),
    );
  }

  const raw = read.value;
  const metadata = parseLockMetadata(raw);

  if (metadata === undefined)
    return { raw, reason: 'lock metadata is malformed', state: 'invalid' };

  if (metadata.hostname !== hostname())
    return {
      metadata,
      raw,
      reason: 'lock belongs to another hostname and cannot be proven stale locally',
      state: 'unknown',
    };

  const present = yield* isProcessPresent(metadata.pid).pipe(
    Effect.mapError(
      (cause) =>
        new ProjectTransactionError('project_locked', 'Could not inspect project lock owner.', {
          cause,
        }),
    ),
  );

  if (!present) return { metadata, raw, reason: 'owner process no longer exists', state: 'stale' };

  if (metadata.process_start_identity === null)
    return {
      metadata,
      raw,
      reason: 'owner PID is live; start identity was unavailable when the lock was created',
      state: 'live',
    };
  const identity = yield* getProcessStartIdentity(metadata.pid);

  if (identity === null)
    return {
      metadata,
      raw,
      reason: 'owner PID is live; current start identity cannot be inspected',
      state: 'live',
    };

  if (identity !== metadata.process_start_identity)
    return { metadata, raw, reason: 'owner PID was reused by another process', state: 'stale' };

  return { metadata, raw, reason: 'owner process and start identity are live', state: 'live' };
});

/** Rejects a command because another owner holds the lock; a stale lock is never stolen. */
const throwForExistingLock = (
  inspection: Exclude<ProjectLockInspection, { state: 'absent' }>,
): never => {
  if (inspection.state === 'stale') {
    throw new ProjectTransactionError('project_lock_stale', 'The project lock is stale.', {
      path: PROJECT_LOCK_FILE,
      hint: 'Confirm no Attest process is running, delete `.attest/project.lock`, then rerun the command.',
      details: {
        lock: inspection.metadata,
        lock_state: inspection.state,
        reason: inspection.reason,
      },
    });
  }

  const details: ProjectLockFailureDetails = {
    lock_state: inspection.state,
    reason: inspection.reason,
  };

  if (inspection.state !== 'invalid') details.lock = inspection.metadata;

  throw new ProjectTransactionError(
    'project_locked',
    inspection.state === 'invalid'
      ? 'The project lock is malformed and cannot be safely classified.'
      : 'The project is locked by another process.',
    {
      path: PROJECT_LOCK_FILE,
      details,
    },
  );
};

type ProjectLockFailureDetails = {
  lock_state: Exclude<ProjectLockInspection, { state: 'absent' }>['state'];
  reason: Exclude<ProjectLockInspection, { state: 'absent' }>['reason'];
  lock?: typeof projectLockSchema.Type;
};

/** Creates and durably writes an exclusive lock, closing immediately after initialization. */
const acquireProjectLock = Effect.fn('acquireProjectLock')(function* (
  root: string,
): Effect.fn.Return<ProjectLockHandle, ProjectLockFailure> {
  const path = yield* resolveContainedPath(root, PROJECT_LOCK_FILE, {
    expect: 'file',
    createDirectories: true,
    problem: () =>
      new ProjectTransactionError('project_invalid', 'Unsafe project lock path.', {
        path: PROJECT_LOCK_FILE,
      }),
  });

  const metadata: ProjectLockMetadata = {
    schema: PROJECT_LOCK_SCHEMA,
    owner_token: randomUUID(),
    pid: process.pid,
    process_start_identity: yield* getProcessStartIdentity(process.pid),
    hostname: hostname(),
    created_at: new Date().toISOString(),
  };

  const opened = yield* Effect.result(anchoredCall('open', path, () => open(path, 'wx', 0o600)));

  if (opened._tag === 'Failure') {
    if (opened.failure.code === 'EEXIST') {
      const inspection = yield* inspectProjectLock(root);

      if (inspection.state === 'absent') return yield* acquireProjectLock(root);

      return yield* Effect.try({
        try: () => throwForExistingLock(inspection),
        catch: (cause) =>
          cause instanceof ProjectTransactionError
            ? cause
            : new ProjectTransactionError('project_locked', 'Could not classify lock.', { cause }),
      });
    }

    return yield* Effect.fail(
      new ProjectTransactionError('project_transaction_failed', 'Could not create project lock.', {
        path: PROJECT_LOCK_FILE,
        cause: opened.failure,
      }),
    );
  }

  let identity: { dev: bigint; ino: bigint } | undefined;
  let closed: Exit.Exit<unknown, ProjectLockFailure> = Exit.void;

  const initialized = yield* Effect.exit(
    Effect.acquireUseRelease(
      Effect.succeed(opened.success),
      (handle) =>
        Effect.gen(function* () {
          identity = yield* anchoredCall('fstat', path, () => handle.stat({ bigint: true }));
          yield* anchoredCall('writeFile', path, () =>
            handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8'),
          );
          yield* anchoredCall('fsync', path, () => handle.sync());
        }),
      (handle) =>
        Effect.gen(function* () {
          closed = yield* Effect.exit(anchoredCall('close', path, () => handle.close()));
        }),
    ),
  );

  const publication = yield* Effect.exit(
    Effect.gen(function* () {
      yield* initialized;

      if (Exit.isFailure(closed))
        return yield* Effect.fail(
          new ProjectTransactionError(
            'project_transaction_failed',
            'Could not close project lock.',
            { cause: closed.cause },
          ),
        );
      yield* syncPath(dirname(path));
    }),
  );

  if (Exit.isFailure(publication)) {
    // Only remove the exclusive inode created here, even if initialization never wrote a token.
    const removed = yield* Effect.exit(
      Effect.gen(function* () {
        if (identity === undefined)
          return yield* Effect.fail(
            new ProjectTransactionError(
              'project_locked',
              'Lock identity could not be confirmed for cleanup.',
            ),
          );
        const current = yield* anchoredCall('lstat', path, () => lstat(path, { bigint: true }));

        if (current.dev !== identity.dev || current.ino !== identity.ino)
          return yield* Effect.fail(
            new ProjectTransactionError(
              'project_locked',
              'Lock identity changed during acquisition.',
            ),
          );
        yield* anchoredCall('unlink', path, () => unlink(path));
        yield* syncPath(dirname(path));
      }),
    );

    let cause = publication.cause;

    if (Exit.isFailure(closed)) cause = annotateProjectCleanup(cause, closed.cause);

    if (Exit.isFailure(removed)) cause = annotateProjectCleanup(cause, removed.cause);

    return yield* Effect.failCause(cause);
  }

  if (identity === undefined)
    return yield* Effect.fail(
      new ProjectTransactionError('project_locked', 'Lock identity unavailable.'),
    );

  return { metadata, identity, path, root };
}, Effect.uninterruptible);

/** Releases only the current token; a replacement owner is never deliberately removed. */
const releaseProjectLock = Effect.fn('releaseProjectLock')(function* (lock: ProjectLockHandle) {
  const inspection = yield* inspectProjectLock(lock.root);

  if (
    inspection.state === 'absent' ||
    inspection.state === 'invalid' ||
    inspection.metadata.owner_token !== lock.metadata.owner_token
  ) {
    return yield* Effect.fail(
      new ProjectTransactionError('project_locked', 'Project lock ownership changed.', {
        path: PROJECT_LOCK_FILE,
        details: { lock_state: inspection.state },
      }),
    );
  }

  const identity = yield* anchoredCall('lstat', lock.path, () =>
    lstat(lock.path, { bigint: true }),
  );

  if (identity.dev !== lock.identity.dev || identity.ino !== lock.identity.ino)
    return yield* Effect.fail(
      new ProjectTransactionError('project_locked', 'Project lock inode changed.'),
    );
  yield* anchoredCall('unlink', lock.path, () => unlink(lock.path));
  yield* syncPath(dirname(lock.path));
}, Effect.uninterruptible);

/** Registers lock release immediately and preserves primary failure, defect and interruption. */
const withProjectLock = Effect.fn('withProjectLock')(function* <A, E extends Error>(
  root: string,
  use: (lock: ProjectLockHandle) => Effect.Effect<A, E>,
  evidence: (value: A) => Record<string, string | boolean> = () => ({}),
) {
  let cleanup: Exit.Exit<unknown, Error> = Exit.void;

  const primary = yield* Effect.exit(
    Effect.acquireUseRelease(
      acquireProjectLock(root),
      (lock) => Effect.suspend(() => use(lock)),
      (lock) =>
        Effect.gen(function* () {
          cleanup = yield* Effect.exit(releaseProjectLock(lock));
        }),
    ),
  );

  if (Exit.isFailure(cleanup)) {
    if (Exit.isFailure(primary))
      return yield* Effect.failCause(annotateProjectCleanup(primary.cause, cleanup.cause));

    const details = evidence(primary.value);

    return yield* Effect.fail(
      new ProjectTransactionError(
        details.committed === true ? 'project_saved_cleanup_failed' : 'project_transaction_failed',
        'Project operation completed but lock release failed.',
        {
          details: { ...details, lock_released: false },
          cause: { primary, cleanup: cleanup.cause },
        },
      ),
    );
  }

  return yield* primary;
}, Effect.uninterruptible);

export {
  PROJECT_LOCK_FILE,
  PROJECT_LOCK_SCHEMA,
  acquireProjectLock,
  inspectProjectLock,
  releaseProjectLock,
  withProjectLock,
  ProjectLockCleanup,
  annotateProjectCleanup,
  throwForExistingLock,
  type ProjectLockHandle,
  type ProjectLockMetadata,
};
