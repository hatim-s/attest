import { type ChildProcess, spawn } from 'node:child_process';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Deferred from 'effect/Deferred';
import * as Exit from 'effect/Exit';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

import { errnoCode } from './errno-code.js';

/** Retains a failed ps release without replacing the observation's primary Cause. */
class ProcessObservationCleanup extends Context.Service<
  ProcessObservationCleanup,
  Cause.Cause<never>
>()('attest/executor/ProcessObservationCleanup') {}

const PROCESS_EXIT_POLL_INTERVAL_MS = 25;

const PROCESS_SNAPSHOT_TIMEOUT_MS = 2000;

const SWEEP_DEADLINE_MS = 5000;

type ProcessIdentity = {
  processId: number;
  startedAt: string;
  command: string;
};

/** Separates an unavailable observation from an observed empty descendant set. */
type ProcessSnapshot = { identities: ProcessIdentity[]; available: boolean };

/** Cleanup is confirmed only when observation succeeded and no known descendant survives. */
type ProcessCleanup = { unreapedProcessIds: number[]; cleanupConfirmed: boolean };

type ProcessRow = ProcessIdentity & { parentProcessId: number };

const PROCESS_ROW_PATTERN =
  /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;

const PROCESS_IDENTITY_PATTERN =
  /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;

const isMissingProcess = (cause: unknown): boolean => errnoCode(cause) === 'ESRCH';

const isPermissionDenied = (cause: unknown): boolean => errnoCode(cause) === 'EPERM';

/** Sends a signal to a pid, or to its whole group when negated; gone or foreign targets are skipped. */
const sendSignal = (target: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(target, signal);
  } catch (error) {
    if (isMissingProcess(error) || isPermissionDenied(error)) return;
    throw error;
  }
};

const processIds = (identities: readonly ProcessIdentity[]): number[] =>
  identities.map(({ processId }) => processId);

/** Waits until the poll interval, the grace deadline, or the sweep deadline, whichever is first. */
const waitForNextPoll = (graceDeadline: number, sweepDeadline: number): Effect.Effect<void> =>
  Effect.sleep(
    Math.min(
      PROCESS_EXIT_POLL_INTERVAL_MS,
      Math.max(0, graceDeadline - Date.now()),
      Math.max(0, sweepDeadline - Date.now()),
    ),
  );

const isProcessGroupAlive = (processId: number): boolean => {
  try {
    process.kill(-processId, 0);

    return true;
  } catch (error) {
    if (isMissingProcess(error)) {
      return false;
    }

    if (isPermissionDenied(error)) {
      return true;
    }

    throw error;
  }
};

/**
 * Runs one bounded ps query. A wedged ps must never stall agent termination, so expiry kills the
 * snapshot child and deliberately degrades cleanup to process-group-only best effort.
 */
const readProcessListing = Effect.fn('process.readListing')(function* (
  argumentsList: readonly string[],
  deadline = Date.now() + PROCESS_SNAPSHOT_TIMEOUT_MS,
  options: { emptyWhenNoMatch?: boolean } = {},
): Effect.fn.Return<string | undefined> {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const timeoutMs = Math.min(PROCESS_SNAPSHOT_TIMEOUT_MS, deadline - Date.now());

      if (timeoutMs <= 0) return undefined;

      const spawned = yield* Effect.try({
        try: () => spawn('ps', [...argumentsList], { stdio: ['ignore', 'pipe', 'ignore'] }),
        catch: () => undefined,
      }).pipe(Effect.result);

      if (spawned._tag === 'Failure') return undefined;
      const snapshot = spawned.success;
      const chunks: Buffer[] = [];
      const completion = Deferred.makeUnsafe<string | undefined>();
      const closed = Deferred.makeUnsafe<void>();

      const data = (chunk: Buffer): void => {
        chunks.push(chunk);
      };

      const error = (): void => {
        Deferred.doneUnsafe(completion, Effect.succeed(undefined));
      };

      const close = (code: number | null): void => {
        const output = Buffer.concat(chunks).toString('utf8');
        const noMatch = options.emptyWhenNoMatch === true && code === 1 && output.trim() === '';
        Deferred.doneUnsafe(completion, Effect.succeed(code === 0 || noMatch ? output : undefined));
        Deferred.doneUnsafe(closed, Effect.void);
      };

      snapshot.stdout?.on('data', data);
      snapshot.once('error', error);
      snapshot.once('close', close);

      // Only ps observation is bounded. Termination evidence is never raced or discarded.
      const primary = yield* Effect.exit(
        restore(Effect.timeoutOption(Effect.interruptible(Deferred.await(completion)), timeoutMs)),
      );

      const cleanup = yield* Effect.exit(
        Effect.gen(function* () {
          if (snapshot.exitCode === null && snapshot.signalCode === null) snapshot.kill('SIGKILL');

          // Joining is bounded by the sweep's remaining budget. Missing close means unavailable evidence.
          const joined = yield* Effect.timeoutOption(
            Effect.interruptible(Deferred.await(closed)),
            Math.max(0, Math.min(100, deadline - Date.now())),
          );

          snapshot.stdout?.off('data', data);
          snapshot.stdout?.destroy();

          return Option.isSome(joined);
        }),
      );

      if (Exit.isFailure(primary)) {
        if (Exit.isFailure(cleanup)) {
          return yield* Effect.failCause(
            Cause.annotate(primary.cause, Context.make(ProcessObservationCleanup, cleanup.cause)),
          );
        }

        return yield* Effect.failCause(primary.cause);
      }

      if (Exit.isFailure(cleanup) || !cleanup.value) return undefined;

      return Option.getOrUndefined(primary.value);
    }),
  );
});

const parseProcessRows = (snapshotText: string): ProcessRow[] => {
  return snapshotText.split('\n').flatMap((line) => {
    const match = PROCESS_ROW_PATTERN.exec(line);

    if (match === null) {
      return [];
    }

    const processId = Number(match[1]);
    const parentProcessId = Number(match[2]);
    const startedAt = match[3];
    const command = match[4];

    if (
      !Number.isSafeInteger(processId) ||
      !Number.isSafeInteger(parentProcessId) ||
      startedAt === undefined ||
      command === undefined
    ) {
      return [];
    }

    return [{ processId, parentProcessId, startedAt, command }];
  });
};

/**
 * Parses one ps fixture into the complete descendant closure without performing I/O. Identity is
 * retained for best-effort PID-reuse detection before descendant signalling.
 */
const parseProcessSnapshot = (snapshotText: string, rootProcessId: number): ProcessIdentity[] => {
  const childRowsByParent = new Map<number, ProcessRow[]>();

  for (const row of parseProcessRows(snapshotText)) {
    const childRows = childRowsByParent.get(row.parentProcessId) ?? [];
    childRows.push(row);
    childRowsByParent.set(row.parentProcessId, childRows);
  }

  const descendants: ProcessIdentity[] = [];
  const visitedProcessIds = new Set([rootProcessId]);
  const pendingParentProcessIds = [rootProcessId];

  for (let index = 0; index < pendingParentProcessIds.length; index += 1) {
    const parentProcessId = pendingParentProcessIds[index];
    const childRows = childRowsByParent.get(parentProcessId ?? -1) ?? [];

    for (const childRow of childRows) {
      if (visitedProcessIds.has(childRow.processId)) {
        continue;
      }

      visitedProcessIds.add(childRow.processId);
      descendants.push({
        processId: childRow.processId,
        startedAt: childRow.startedAt,
        command: childRow.command,
      });
      pendingParentProcessIds.push(childRow.processId);
    }
  }

  return descendants;
};

/** Reads a bounded process table for identity-checked descendant discovery. */
const readProcessSnapshot = Effect.fn('process.readProcessSnapshot')(function* (
  deadline?: number,
): Effect.fn.Return<string | undefined> {
  return yield* readProcessListing(['-Ao', 'pid=,ppid=,lstart=,comm='], deadline);
});

/** Observes descendants without interpreting an unavailable listing as an empty process tree. */
const listDescendantProcesses = Effect.fn('process.listDescendantProcesses')(function* (
  rootProcessId: number,
): Effect.fn.Return<ProcessSnapshot> {
  const snapshotText = yield* readProcessSnapshot();

  return {
    identities: snapshotText === undefined ? [] : parseProcessSnapshot(snapshotText, rootProcessId),
    available: snapshotText !== undefined,
  };
});

/** Parses the output of one batched identity query. */
const parseIdentitySnapshot = (snapshotText: string): ProcessIdentity[] => {
  return snapshotText.split('\n').flatMap((line) => {
    const match = PROCESS_IDENTITY_PATTERN.exec(line);
    const processId = Number(match?.[1]);
    const startedAt = match?.[2];
    const command = match?.[3];

    return Number.isSafeInteger(processId) && startedAt !== undefined && command !== undefined
      ? [{ processId, startedAt, command }]
      : [];
  });
};

/** Keys a process by pid, start time, and command so a reused pid never matches an old identity. */
const identityKey = (identity: ProcessIdentity): string => {
  return `${String(identity.processId)}\u0000${identity.startedAt}\u0000${identity.command}`;
};

const mergeIdentities = (
  identitiesByKey: Map<string, ProcessIdentity>,
  identities: readonly ProcessIdentity[],
): void => {
  for (const identity of identities) {
    identitiesByKey.set(identityKey(identity), identity);
  }
};

/** Revalidates pid, start time and command before any descendant signal. */
const readMatchingIdentities = Effect.fn('process.readMatchingIdentities')(function* (
  identities: readonly ProcessIdentity[],
  deadline: number,
): Effect.fn.Return<ProcessIdentity[] | undefined> {
  if (identities.length === 0) {
    return [];
  }

  const queriedIds = [...new Set(processIds(identities))];

  const snapshotText = yield* readProcessListing(
    ['-o', 'pid=,lstart=,comm=', '-p', queriedIds.join(',')],
    deadline,
    { emptyWhenNoMatch: true },
  );

  if (snapshotText === undefined) {
    return undefined;
  }

  const currentByProcessId = new Map(
    parseIdentitySnapshot(snapshotText).map((identity) => [identity.processId, identity]),
  );

  return identities.filter((identity) => {
    const current = currentByProcessId.get(identity.processId);

    return current?.startedAt === identity.startedAt && current.command === identity.command;
  });
});

/** Finds descendants of the owned root and every previously tracked child. */
const discoverDescendants = Effect.fn('process.discoverDescendants')(function* (
  rootProcessId: number,
  knownIdentities: readonly ProcessIdentity[],
  deadline: number,
): Effect.fn.Return<ProcessIdentity[] | undefined> {
  const snapshotText = yield* readProcessSnapshot(deadline);

  if (snapshotText === undefined) {
    return undefined;
  }

  const roots = [rootProcessId, ...knownIdentities.map(({ processId }) => processId)];

  return roots.flatMap((processId) => parseProcessSnapshot(snapshotText, processId));
});

/** Observes new descendants during grace and signals only revalidated identities. */
const waitThroughTerminationGrace = Effect.fn('process.waitThroughTerminationGrace')(function* (
  rootProcessId: number,
  identitiesByKey: Map<string, ProcessIdentity>,
  graceDeadline: number,
  sweepDeadline: number,
): Effect.fn.Return<boolean> {
  while (Date.now() < graceDeadline && Date.now() < sweepDeadline) {
    const identities = [...identitiesByKey.values()];
    const discovered = yield* discoverDescendants(rootProcessId, identities, sweepDeadline);

    if (discovered === undefined) {
      return false;
    }

    const newIdentities = discovered.filter(
      (identity) => !identitiesByKey.has(identityKey(identity)),
    );

    mergeIdentities(identitiesByKey, newIdentities);

    const survivors = yield* readMatchingIdentities([...identitiesByKey.values()], sweepDeadline);

    if (survivors === undefined) {
      return false;
    }

    const newIdentityKeys = new Set(newIdentities.map(identityKey));

    for (const identity of survivors) {
      if (newIdentityKeys.has(identityKey(identity))) {
        sendSignal(identity.processId, 'SIGTERM');
      }
    }

    if (!isProcessGroupAlive(rootProcessId) && survivors.length === 0) {
      return true;
    }

    yield* waitForNextPoll(graceDeadline, sweepDeadline);
  }

  return true;
});

/**
 * Re-reads identities until none survive or `pollDeadline` passes. `complete` is false when ps
 * became unavailable mid-poll; `survivors` then holds the last identities known to be alive.
 */
const pollSurvivors = Effect.fn('process.pollSurvivors')(function* (
  identities: readonly ProcessIdentity[],
  pollDeadline: number,
  sweepDeadline: number,
): Effect.fn.Return<{ survivors: ProcessIdentity[]; complete: boolean }> {
  const initial = yield* readMatchingIdentities(identities, sweepDeadline);

  if (initial === undefined) return { survivors: [...identities], complete: false };
  let survivors: ProcessIdentity[] = initial;

  while (survivors.length > 0 && Date.now() < pollDeadline) {
    yield* waitForNextPoll(pollDeadline, sweepDeadline);

    const next: ProcessIdentity[] | undefined = yield* readMatchingIdentities(
      survivors,
      sweepDeadline,
    );

    if (next === undefined) return { survivors, complete: false };
    survivors = next;
  }

  return { survivors, complete: true };
});

const isDirectChildAlive = (child: ChildProcess): boolean => {
  return child.exitCode === null && child.signalCode === null;
};

const signalIdentities = (identities: readonly ProcessIdentity[], signal: NodeJS.Signals): void => {
  for (const identity of identities) sendSignal(identity.processId, signal);
};

/** Starts a CLI agent in its own process group for best-effort macOS/Linux tree containment. */
const spawnInProcessGroup = (
  command: readonly string[],
  options: { cwd: string; env: Record<string, string> },
): ChildProcess => {
  const [executable, ...argumentsList] = command;

  if (executable === undefined) {
    throw new TypeError('CLI agent command must contain an executable');
  }

  return spawn(executable, argumentsList, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
};

/**
 * Performs the hardened best-effort cleanup sweep required by docs/specs/agent-contract.md on every
 * terminal path. Batched identity checks are best-effort detection that reduces PID-reuse risk;
 * same-second same-command reuse and check-to-kill races remain possible. Verified survivors and
 * candidates left when the five-second sweep deadline expires are returned for diagnostics.
 */
const killProcessTree = Effect.fn('process.killProcessTree')(function* (
  child: ChildProcess,
  options: {
    graceMs: number;
    initialDescendants?: readonly ProcessIdentity[];
    /** A failed earlier snapshot cannot be repaired after descendants may have reparented. */
    initialObservationAvailable?: boolean;
    /** Whether the direct child is still owned and live, allowing process-group signalling. */
    signalProcessGroup: boolean;
  },
): Effect.fn.Return<ProcessCleanup> {
  const rootProcessId = child.pid;

  if (rootProcessId === undefined) {
    return { unreapedProcessIds: [], cleanupConfirmed: true };
  }

  const result = (identities: readonly ProcessIdentity[], available = true): ProcessCleanup => ({
    unreapedProcessIds: processIds(identities),
    cleanupConfirmed:
      available && options.initialObservationAvailable !== false && identities.length === 0,
  });

  const killGroupIfAlive = (): void => {
    if (isDirectChildAlive(child)) sendSignal(-rootProcessId, 'SIGKILL');
  };

  const sweepDeadline = Date.now() + SWEEP_DEADLINE_MS;
  const graceDeadline = Math.min(sweepDeadline, Date.now() + options.graceMs);
  const identitiesByKey = new Map<string, ProcessIdentity>();
  mergeIdentities(identitiesByKey, options.initialDescendants ?? []);
  let discoveryAvailable = true;

  if (options.signalProcessGroup) {
    const latestDescendants = yield* discoverDescendants(rootProcessId, [], sweepDeadline);

    if (latestDescendants !== undefined) {
      mergeIdentities(identitiesByKey, latestDescendants);
    } else {
      discoveryAvailable = false;
    }

    if (isDirectChildAlive(child)) sendSignal(-rootProcessId, 'SIGTERM');
  }

  const identities = [...identitiesByKey.values()];

  if (!discoveryAvailable) {
    yield* Effect.sleep(Math.max(0, graceDeadline - Date.now()));
    killGroupIfAlive();

    return result(identities, false);
  }

  const termMatches = yield* readMatchingIdentities(identities, sweepDeadline);

  if (termMatches === undefined) {
    if (options.signalProcessGroup) killGroupIfAlive();

    return result(identities, false);
  }

  signalIdentities(termMatches, 'SIGTERM');

  if (options.signalProcessGroup) {
    const snapshotsAvailable = yield* waitThroughTerminationGrace(
      rootProcessId,
      identitiesByKey,
      graceDeadline,
      sweepDeadline,
    );

    killGroupIfAlive();

    if (!snapshotsAvailable) return result([...identitiesByKey.values()], false);
  } else {
    const normalExit = yield* pollSurvivors(termMatches, graceDeadline, sweepDeadline);

    if (!normalExit.complete) return result(termMatches, false);
    identitiesByKey.clear();
    mergeIdentities(identitiesByKey, normalExit.survivors);
  }

  const killCandidates = [...identitiesByKey.values()];
  const killMatches = yield* readMatchingIdentities(killCandidates, sweepDeadline);

  if (killMatches === undefined) return result(killCandidates, false);
  signalIdentities(killMatches, 'SIGKILL');
  const verified = yield* pollSurvivors(killMatches, sweepDeadline, sweepDeadline);

  return result(verified.survivors, verified.complete);
}, Effect.uninterruptible);

export {
  identityKey,
  killProcessTree,
  listDescendantProcesses,
  parseIdentitySnapshot,
  parseProcessSnapshot,
  spawnInProcessGroup,
  type ProcessIdentity,
  type ProcessSnapshot,
  type ProcessCleanup,
};
