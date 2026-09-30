import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

import { errnoCode } from './errno-code.js';

const PROCESS_EXIT_POLL_INTERVAL_MS = 25;
const PROCESS_SNAPSHOT_TIMEOUT_MS = 2000;
const SWEEP_DEADLINE_MS = 5000;

type ProcessIdentity = {
  processId: number;
  startedAt: string;
  command: string;
};

type ProcessRow = ProcessIdentity & { parentProcessId: number };

const PROCESS_ROW_PATTERN =
  /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;
const PROCESS_IDENTITY_PATTERN =
  /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;

const isMissingProcess = (error: unknown): boolean => errnoCode(error) === 'ESRCH';

const isPermissionDenied = (error: unknown): boolean => errnoCode(error) === 'EPERM';

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
const waitForNextPoll = (graceDeadline: number, sweepDeadline: number): Promise<void> =>
  wait(
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
const readProcessListing = async (
  argumentsList: readonly string[],
  deadline = Date.now() + PROCESS_SNAPSHOT_TIMEOUT_MS,
  options: { emptyWhenNoMatch?: boolean } = {},
): Promise<string | undefined> => {
  const timeoutMs = Math.min(PROCESS_SNAPSHOT_TIMEOUT_MS, deadline - Date.now());
  if (timeoutMs <= 0) {
    return undefined;
  }

  let processSnapshot: ChildProcess;
  try {
    processSnapshot = spawn('ps', [...argumentsList], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // Sandboxes and exhausted hosts may reject ps synchronously; containment safely degrades.
    return undefined;
  }
  const standardOutputChunks: Buffer[] = [];
  let timedOut = false;
  processSnapshot.stdout?.on('data', (chunk: Buffer) => standardOutputChunks.push(chunk));

  return await new Promise<string | undefined>((resolve) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      processSnapshot.kill('SIGKILL');
    }, timeoutMs);
    processSnapshot.once('error', () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
    processSnapshot.once('close', (exitCode) => {
      clearTimeout(timeout);
      const output = Buffer.concat(standardOutputChunks).toString('utf8');
      // `ps -p` exits 1 with no rows when none of the queried pids exist: every process is gone.
      const noMatch = options.emptyWhenNoMatch === true && exitCode === 1 && output.trim() === '';
      if (timedOut || (exitCode !== 0 && !noMatch)) {
        resolve(undefined);
        return;
      }

      resolve(output);
    });
  });
};

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

const readProcessSnapshot = async (deadline?: number): Promise<string | undefined> => {
  return readProcessListing(['-Ao', 'pid=,ppid=,lstart=,comm='], deadline);
};

const listDescendantProcesses = async (rootProcessId: number): Promise<ProcessIdentity[]> => {
  const snapshotText = await readProcessSnapshot();
  return snapshotText === undefined ? [] : parseProcessSnapshot(snapshotText, rootProcessId);
};

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

const readMatchingIdentities = async (
  identities: readonly ProcessIdentity[],
  deadline: number,
): Promise<ProcessIdentity[] | undefined> => {
  if (identities.length === 0) {
    return [];
  }

  const queriedIds = [...new Set(processIds(identities))];
  const snapshotText = await readProcessListing(
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
};

const discoverDescendants = async (
  rootProcessId: number,
  knownIdentities: readonly ProcessIdentity[],
  deadline: number,
): Promise<ProcessIdentity[] | undefined> => {
  const snapshotText = await readProcessSnapshot(deadline);
  if (snapshotText === undefined) {
    return undefined;
  }

  const roots = [rootProcessId, ...knownIdentities.map(({ processId }) => processId)];
  return roots.flatMap((processId) => parseProcessSnapshot(snapshotText, processId));
};

const waitThroughTerminationGrace = async (
  rootProcessId: number,
  identitiesByKey: Map<string, ProcessIdentity>,
  graceDeadline: number,
  sweepDeadline: number,
): Promise<boolean> => {
  while (Date.now() < graceDeadline && Date.now() < sweepDeadline) {
    const identities = [...identitiesByKey.values()];
    const discovered = await discoverDescendants(rootProcessId, identities, sweepDeadline);
    if (discovered === undefined) {
      return false;
    }
    const newIdentities = discovered.filter(
      (identity) => !identitiesByKey.has(identityKey(identity)),
    );
    mergeIdentities(identitiesByKey, newIdentities);

    const survivors = await readMatchingIdentities([...identitiesByKey.values()], sweepDeadline);
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

    await waitForNextPoll(graceDeadline, sweepDeadline);
  }
  return true;
};

/**
 * Re-reads identities until none survive or `pollDeadline` passes. `complete` is false when ps
 * became unavailable mid-poll; `survivors` then holds the last identities known to be alive.
 */
const pollSurvivors = async (
  identities: readonly ProcessIdentity[],
  pollDeadline: number,
  sweepDeadline: number,
): Promise<{ survivors: ProcessIdentity[]; complete: boolean }> => {
  let survivors = await readMatchingIdentities(identities, sweepDeadline);
  if (survivors === undefined) return { survivors: [...identities], complete: false };
  while (survivors.length > 0 && Date.now() < pollDeadline) {
    await waitForNextPoll(pollDeadline, sweepDeadline);
    const next = await readMatchingIdentities(survivors, sweepDeadline);
    if (next === undefined) return { survivors, complete: false };
    survivors = next;
  }
  return { survivors, complete: true };
};

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
const killProcessTree = async (
  child: ChildProcess,
  options: {
    graceMs: number;
    initialDescendants?: readonly ProcessIdentity[];
    /** Whether the direct child is still owned and live, allowing process-group signalling. */
    signalProcessGroup: boolean;
  },
): Promise<number[]> => {
  const rootProcessId = child.pid;
  if (rootProcessId === undefined) {
    return [];
  }

  const killGroupIfAlive = (): void => {
    if (isDirectChildAlive(child)) sendSignal(-rootProcessId, 'SIGKILL');
  };
  const sweepDeadline = Date.now() + SWEEP_DEADLINE_MS;
  const graceDeadline = Math.min(sweepDeadline, Date.now() + options.graceMs);
  const identitiesByKey = new Map<string, ProcessIdentity>();
  mergeIdentities(identitiesByKey, options.initialDescendants ?? []);
  let discoveryAvailable = true;
  if (options.signalProcessGroup) {
    const latestDescendants = await discoverDescendants(rootProcessId, [], sweepDeadline);
    if (latestDescendants !== undefined) {
      mergeIdentities(identitiesByKey, latestDescendants);
    } else {
      discoveryAvailable = false;
    }
    if (isDirectChildAlive(child)) sendSignal(-rootProcessId, 'SIGTERM');
  }

  const identities = [...identitiesByKey.values()];
  if (!discoveryAvailable) {
    await wait(Math.max(0, graceDeadline - Date.now()));
    killGroupIfAlive();
    return processIds(identities);
  }
  const termMatches = await readMatchingIdentities(identities, sweepDeadline);
  if (termMatches === undefined) {
    if (options.signalProcessGroup) killGroupIfAlive();
    return processIds(identities);
  }
  signalIdentities(termMatches, 'SIGTERM');

  if (options.signalProcessGroup) {
    const snapshotsAvailable = await waitThroughTerminationGrace(
      rootProcessId,
      identitiesByKey,
      graceDeadline,
      sweepDeadline,
    );
    killGroupIfAlive();
    if (!snapshotsAvailable) return processIds([...identitiesByKey.values()]);
  } else {
    const normalExit = await pollSurvivors(termMatches, graceDeadline, sweepDeadline);
    if (!normalExit.complete) return processIds(termMatches);
    identitiesByKey.clear();
    mergeIdentities(identitiesByKey, normalExit.survivors);
  }

  const killCandidates = [...identitiesByKey.values()];
  const killMatches = await readMatchingIdentities(killCandidates, sweepDeadline);
  if (killMatches === undefined) return processIds(killCandidates);
  signalIdentities(killMatches, 'SIGKILL');
  const verified = await pollSurvivors(killMatches, sweepDeadline, sweepDeadline);
  return processIds(verified.survivors);
};

export {
  identityKey,
  killProcessTree,
  listDescendantProcesses,
  parseIdentitySnapshot,
  parseProcessSnapshot,
  spawnInProcessGroup,
  type ProcessIdentity,
};
