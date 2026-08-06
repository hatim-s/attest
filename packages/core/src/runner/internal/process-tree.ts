import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

const PROCESS_EXIT_POLL_INTERVAL_MS = 25;

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

const isProcessAlive = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
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

const haveAllProcessesExited = (processId: number, descendantProcessIds: number[]): boolean => {
  return (
    !isProcessGroupAlive(processId) &&
    descendantProcessIds.every((descendantProcessId) => !isProcessAlive(descendantProcessId))
  );
};

const waitForProcessTreeExit = async (
  processId: number,
  descendantProcessIds: number[],
  graceMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + graceMs;

  while (Date.now() < deadline) {
    if (haveAllProcessesExited(processId, descendantProcessIds)) {
      return true;
    }

    await wait(Math.min(PROCESS_EXIT_POLL_INTERVAL_MS, deadline - Date.now()));
  }

  return haveAllProcessesExited(processId, descendantProcessIds);
};

const readProcessSnapshot = async (): Promise<string> => {
  const processSnapshot = spawn('ps', ['-Ao', 'pid=,ppid='], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const standardOutputChunks: Buffer[] = [];
  const standardErrorChunks: Buffer[] = [];

  processSnapshot.stdout.on('data', (chunk: Buffer) => standardOutputChunks.push(chunk));
  processSnapshot.stderr.on('data', (chunk: Buffer) => standardErrorChunks.push(chunk));

  return await new Promise<string>((resolve, reject) => {
    processSnapshot.once('error', reject);
    processSnapshot.once('close', (exitCode) => {
      if (exitCode === 0) {
        resolve(Buffer.concat(standardOutputChunks).toString('utf8'));
        return;
      }

      const standardError = Buffer.concat(standardErrorChunks).toString('utf8').trim();
      reject(new Error(`Failed to snapshot processes with ps: ${standardError || exitCode}`));
    });
  });
};

/**
 * Snapshots the complete descendant closure using one POSIX process-table read.
 *
 * The execution semantics in docs/specs/agent-contract.md require full process-tree cleanup.
 * This snapshot must happen before SIGTERM because descendants reparent to init/launchd once
 * their parent dies, severing the parent-child relationship needed to discover escapees.
 */
const listDescendantProcessIds = async (rootProcessId: number): Promise<number[]> => {
  const processSnapshot = await readProcessSnapshot();
  const childProcessIdsByParent = new Map<number, number[]>();

  for (const line of processSnapshot.split('\n')) {
    const [processIdText, parentProcessIdText] = line.trim().split(/\s+/);
    const processId = Number(processIdText);
    const parentProcessId = Number(parentProcessIdText);
    if (!Number.isSafeInteger(processId) || !Number.isSafeInteger(parentProcessId)) {
      continue;
    }

    const childProcessIds = childProcessIdsByParent.get(parentProcessId) ?? [];
    childProcessIds.push(processId);
    childProcessIdsByParent.set(parentProcessId, childProcessIds);
  }

  const descendantProcessIds: number[] = [];
  const pendingParentProcessIds = [rootProcessId];
  for (let index = 0; index < pendingParentProcessIds.length; index += 1) {
    const childProcessIds = childProcessIdsByParent.get(pendingParentProcessIds[index] ?? -1) ?? [];
    descendantProcessIds.push(...childProcessIds);
    pendingParentProcessIds.push(...childProcessIds);
  }

  return descendantProcessIds;
};

/**
 * Starts a CLI agent in its own process group so the execution semantics in
 * docs/specs/agent-contract.md can terminate every process created by the agent.
 */
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
 * Terminates and reaps an agent process tree with the grace period required by
 * docs/specs/agent-contract.md, including descendants that escaped into another session.
 *
 * Processes that both daemonize and are spawned after the snapshot can still escape. That
 * inherent race requires OS-level containment and should only be revisited with such containment.
 */
const killProcessTree = async (
  child: ChildProcess,
  options: { graceMs: number },
): Promise<void> => {
  const processId = child.pid;
  if (processId === undefined) {
    return;
  }

  const descendantProcessIds = await listDescendantProcessIds(processId);
  signalProcessGroup(processId, 'SIGTERM');
  for (const descendantProcessId of descendantProcessIds) {
    signalProcess(descendantProcessId, 'SIGTERM');
  }

  if (await waitForProcessTreeExit(processId, descendantProcessIds, options.graceMs)) {
    return;
  }

  signalProcessGroup(processId, 'SIGKILL');
  for (const descendantProcessId of descendantProcessIds) {
    if (isProcessAlive(descendantProcessId)) {
      signalProcess(descendantProcessId, 'SIGKILL');
    }
  }
};

export { killProcessTree, listDescendantProcessIds, spawnInProcessGroup };
