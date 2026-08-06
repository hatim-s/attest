import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

const PROCESS_EXIT_POLL_INTERVAL_MS = 25;
const PROCESS_SNAPSHOT_TIMEOUT_MS = 2000;
const PROCESS_EXIT_VERIFICATION_MS = 2000;

type ProcessIdentity = {
  processId: number;
  startedAt: string;
  command: string;
};

type ProcessRow = ProcessIdentity & { parentProcessId: number };

const PROCESS_ROW_PATTERN =
  /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;
const PROCESS_IDENTITY_PATTERN =
  /^\s*(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;

const isMissingProcess = (error: unknown): boolean => {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
};

const isPermissionDenied = (error: unknown): boolean => {
  return error instanceof Error && 'code' in error && error.code === 'EPERM';
};

const signalProcessGroup = (processId: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(-processId, signal);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) {
      return false;
    }

    throw error;
  }
};

const signalProcess = (processId: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(processId, signal);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) {
      return false;
    }

    throw error;
  }
};

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
): Promise<string | undefined> => {
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
    }, PROCESS_SNAPSHOT_TIMEOUT_MS);
    processSnapshot.once('error', () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
    processSnapshot.once('close', (exitCode) => {
      clearTimeout(timeout);
      if (timedOut || exitCode !== 0) {
        resolve(undefined);
        return;
      }

      resolve(Buffer.concat(standardOutputChunks).toString('utf8'));
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
 * retained because docs/specs/agent-contract.md cleanup must never signal an unrelated reused PID.
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

const readProcessSnapshot = async (): Promise<string | undefined> => {
  return readProcessListing(['-Ao', 'pid=,ppid=,lstart=,comm=']);
};

const listDescendantProcesses = async (rootProcessId: number): Promise<ProcessIdentity[]> => {
  const snapshotText = await readProcessSnapshot();
  return snapshotText === undefined ? [] : parseProcessSnapshot(snapshotText, rootProcessId);
};

const parseIdentityListing = (
  identityText: string,
  processId: number,
): ProcessIdentity | undefined => {
  const match = PROCESS_IDENTITY_PATTERN.exec(identityText.trim());
  const startedAt = match?.[1];
  const command = match?.[2];
  return startedAt === undefined || command === undefined
    ? undefined
    : { processId, startedAt, command };
};

const readProcessIdentity = async (processId: number): Promise<ProcessIdentity | undefined> => {
  const identityText = await readProcessListing(['-o', 'lstart=,comm=', '-p', String(processId)]);
  return identityText === undefined ? undefined : parseIdentityListing(identityText, processId);
};

const hasMatchingIdentity = async (identity: ProcessIdentity): Promise<boolean> => {
  const current = await readProcessIdentity(identity.processId);
  return current?.startedAt === identity.startedAt && current.command === identity.command;
};

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

const signalMatchingIdentities = async (
  identities: readonly ProcessIdentity[],
  signal: NodeJS.Signals,
): Promise<void> => {
  for (const identity of identities) {
    // Invariant: a bare PID is never signalled unless both immutable ps identity fields still match.
    if (await hasMatchingIdentity(identity)) {
      signalProcess(identity.processId, signal);
    }
  }
};

const matchingIdentities = async (
  identities: readonly ProcessIdentity[],
): Promise<ProcessIdentity[]> => {
  const matches: ProcessIdentity[] = [];
  for (const identity of identities) {
    if (await hasMatchingIdentity(identity)) {
      matches.push(identity);
    }
  }
  return matches;
};

const discoverDescendants = async (
  rootProcessId: number,
  knownIdentities: readonly ProcessIdentity[],
): Promise<ProcessIdentity[]> => {
  const snapshotText = await readProcessSnapshot();
  if (snapshotText === undefined) {
    return [];
  }

  const roots = [rootProcessId, ...knownIdentities.map(({ processId }) => processId)];
  return roots.flatMap((processId) => parseProcessSnapshot(snapshotText, processId));
};

const waitThroughTerminationGrace = async (
  rootProcessId: number,
  identitiesByKey: Map<string, ProcessIdentity>,
  graceMs: number,
): Promise<void> => {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const identities = [...identitiesByKey.values()];
    const discovered = await discoverDescendants(rootProcessId, identities);
    const newIdentities = discovered.filter(
      (identity) => !identitiesByKey.has(identityKey(identity)),
    );
    mergeIdentities(identitiesByKey, newIdentities);
    await signalMatchingIdentities(newIdentities, 'SIGTERM');

    const survivors = await matchingIdentities([...identitiesByKey.values()]);
    if (!isProcessGroupAlive(rootProcessId) && survivors.length === 0) {
      return;
    }

    await wait(Math.min(PROCESS_EXIT_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
};

const verifyKilledIdentities = async (
  identities: readonly ProcessIdentity[],
): Promise<number[]> => {
  const deadline = Date.now() + PROCESS_EXIT_VERIFICATION_MS;
  let survivors = await matchingIdentities(identities);
  while (survivors.length > 0 && Date.now() < deadline) {
    await wait(Math.min(PROCESS_EXIT_POLL_INTERVAL_MS, deadline - Date.now()));
    survivors = await matchingIdentities(survivors);
  }
  return survivors.map(({ processId }) => processId);
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
 * terminal path. Snapshot identities prevent PID-reuse signals; verified SIGKILL survivors are returned.
 */
const killProcessTree = async (
  child: ChildProcess,
  options: { graceMs: number; initialDescendants?: readonly ProcessIdentity[] },
): Promise<number[]> => {
  const rootProcessId = child.pid;
  if (rootProcessId === undefined) {
    return [];
  }

  const rootIdentity = await readProcessIdentity(rootProcessId);
  const identitiesByKey = new Map<string, ProcessIdentity>();
  mergeIdentities(identitiesByKey, options.initialDescendants ?? []);
  mergeIdentities(identitiesByKey, await listDescendantProcesses(rootProcessId));

  signalProcessGroup(rootProcessId, 'SIGTERM');
  await signalMatchingIdentities([...identitiesByKey.values()], 'SIGTERM');
  await waitThroughTerminationGrace(rootProcessId, identitiesByKey, options.graceMs);

  if (rootIdentity !== undefined && (await hasMatchingIdentity(rootIdentity))) {
    signalProcessGroup(rootProcessId, 'SIGKILL');
  }
  const identities = [...identitiesByKey.values()];
  await signalMatchingIdentities(identities, 'SIGKILL');
  return verifyKilledIdentities(identities);
};

export {
  killProcessTree,
  listDescendantProcesses,
  parseProcessSnapshot,
  spawnInProcessGroup,
  type ProcessIdentity,
};
