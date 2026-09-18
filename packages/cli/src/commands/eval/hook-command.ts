import {
  killProcessTree,
  listDescendantProcesses,
  spawnInProcessGroup,
  type ProcessIdentity,
} from '@attest/core';

const HOOK_TERMINATION_GRACE_MS = 1_000;

type HookCommand = { argv: string[]; timeout_ms?: number };
type HookPhase = 'after_case' | 'after_run' | 'before_case' | 'before_run';

class HookCommandError extends Error {
  readonly cleanupConfirmed: boolean;

  constructor(message: string, cleanupConfirmed = true) {
    super(message);
    this.name = 'HookCommandError';
    this.cleanupConfirmed = cleanupConfirmed;
  }
}

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/** Runs one argv-only hook with the core identity-checked process-tree cleanup on every terminal path. */
const runHookCommand = async (options: {
  command: HookCommand;
  cwd: string;
  env: Record<string, string>;
  phase: HookPhase;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<void> => {
  const [file, ...argumentsList] = options.command.argv;
  if (file === undefined) return;
  if (isAborted(options.signal)) {
    throw new HookCommandError(`Eval ${options.phase} hook was aborted.`);
  }

  const child = spawnInProcessGroup([file, ...argumentsList], {
    cwd: options.cwd,
    env: options.env,
  });
  child.stdin?.end();
  child.stdout?.resume();
  child.stderr?.resume();
  const descendantSnapshots: Promise<ProcessIdentity[]>[] = [
    child.pid === undefined ? Promise.resolve([]) : listDescendantProcesses(child.pid),
  ];
  const close = new Promise<void>((resolve) => child.once('close', () => resolve()));
  type Terminal =
    | { type: 'abort' }
    | { type: 'close'; exitCode: number | null }
    | { type: 'spawn_error' }
    | { type: 'timeout' };
  let resolveTerminal: (terminal: Terminal) => void = () => undefined;
  let resolved = false;
  const resolveOnce = (terminal: Terminal): void => {
    if (resolved) return;
    resolved = true;
    resolveTerminal(terminal);
  };
  const terminal = new Promise<Terminal>((resolve) => {
    resolveTerminal = resolve;
  });
  child.once('error', () => resolveOnce({ type: 'spawn_error' }));
  child.once('close', (exitCode) => resolveOnce({ type: 'close', exitCode }));
  const timeout = setTimeout(
    () => resolveOnce({ type: 'timeout' }),
    options.command.timeout_ms ?? options.timeoutMs,
  );
  const abort = (): void => resolveOnce({ type: 'abort' });
  options.signal?.addEventListener('abort', abort, { once: true });
  if (isAborted(options.signal)) abort();

  const result = await terminal;
  clearTimeout(timeout);
  options.signal?.removeEventListener('abort', abort);
  if (child.pid !== undefined && result.type !== 'close') {
    descendantSnapshots.push(listDescendantProcesses(child.pid));
  }
  const unreapedProcessIds = await killProcessTree(child, {
    graceMs: HOOK_TERMINATION_GRACE_MS,
    initialDescendants: (await Promise.all(descendantSnapshots)).flat(),
    signalProcessGroup: result.type !== 'close',
  });
  await close;
  const cleanupConfirmed = unreapedProcessIds.length === 0;

  const cleanupSuffix = cleanupConfirmed ? '' : ' Process cleanup could not be confirmed.';
  if (result.type === 'timeout')
    throw new HookCommandError(
      `Eval ${options.phase} hook timed out.${cleanupSuffix}`,
      cleanupConfirmed,
    );
  if (result.type === 'abort')
    throw new HookCommandError(
      `Eval ${options.phase} hook was aborted.${cleanupSuffix}`,
      cleanupConfirmed,
    );
  if (result.type === 'spawn_error')
    throw new HookCommandError(`Eval ${options.phase} hook could not start.`);
  if (result.exitCode !== 0) {
    throw new HookCommandError(
      `Eval ${options.phase} hook exited with code ${String(result.exitCode)}.${cleanupSuffix}`,
      cleanupConfirmed,
    );
  }
  if (!cleanupConfirmed)
    throw new HookCommandError(
      `Eval ${options.phase} hook process cleanup could not be confirmed.`,
      false,
    );
};

export { HookCommandError, runHookCommand, type HookCommand, type HookPhase };
