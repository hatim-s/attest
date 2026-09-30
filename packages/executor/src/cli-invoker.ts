import type { AgentRequest, RawExcerpt } from '@attest/contracts';
import type { ChildProcess } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentInvocationError } from './errors.js';
import { DEFAULT_TERMINATION_GRACE_MS } from './internal/agent-defaults.js';
import { BoundedTail } from './internal/bounded-tail.js';
import { startTimer } from './internal/elapsed.js';
import { createFailedAttempt } from './internal/failed-attempt.js';
import {
  RAW_EXCERPT_CHARACTERS,
  appendEvidencePrefix,
  createRawExcerpt,
} from './internal/raw-excerpt.js';
import {
  killProcessTree,
  listDescendantProcesses,
  spawnInProcessGroup,
  type ProcessIdentity,
} from './internal/process-tree.js';
import { resolveInvocationEnv } from './invocation-env.js';
import type {
  InvocationAttempt,
  InvocationDiagnostics,
  InvokeOptions,
  NativeAgentTarget,
} from './types.js';

const STDERR_EXCERPT_BYTES = 4096;

type TerminalEvent =
  | { type: 'abort' }
  | { type: 'close'; exitCode: number | null }
  | { type: 'output_cap' }
  | { type: 'spawn_error'; error: Error }
  | { type: 'timeout' };

type InvocationCapture = {
  cleanup: () => void;
  close: Promise<void>;
  terminal: Promise<TerminalEvent>;
  readRawExcerpt: (forceTruncated?: boolean) => RawExcerpt;
  readStderrExcerpt: () => string | undefined;
  readStdout: () => string;
};

type AttemptDirectory = { path: string; remove: boolean };

type CaptureOptions = {
  outputCapBytes: number;
  signal: AbortSignal | undefined;
  timeoutMs: number;
  /** Runs once when stdout first produces data, while the agent is known to be running. */
  onFirstStdout: () => void;
};

/** Builds stdout evidence; a hash of every received byte accompanies any truncated excerpt. */
const createStdoutExcerpt = (
  evidenceChunks: readonly Uint8Array[],
  payloadByteCount: number,
  evidenceByteCount: number,
  payloadHash: Hash,
  forceTruncated: boolean,
): RawExcerpt => {
  const evidence = Buffer.concat(evidenceChunks, evidenceByteCount).toString('utf8');
  const truncated =
    forceTruncated ||
    payloadByteCount > evidenceByteCount ||
    evidence.length > RAW_EXCERPT_CHARACTERS;
  const rawExcerpt = createRawExcerpt(evidence);
  if (!truncated) return rawExcerpt;
  return { ...rawExcerpt, truncated: true, sha256: payloadHash.digest('hex') };
};

const captureInvocation = (child: ChildProcess, options: CaptureOptions): InvocationCapture => {
  const { outputCapBytes, signal, timeoutMs } = options;
  const stdoutChunks: Buffer<ArrayBufferLike>[] = [];
  const evidenceChunks: Uint8Array[] = [];
  const payloadHash = createHash('sha256');
  let stdoutBytes = 0;
  let evidenceBytes = 0;
  const stderrTail = new BoundedTail(STDERR_EXCERPT_BYTES);
  let terminalResolved = false;
  let stdoutStarted = false;
  let resolveTerminal: (event: TerminalEvent) => void = () => undefined;

  const resolveOnce = (event: TerminalEvent): void => {
    if (terminalResolved) {
      return;
    }

    terminalResolved = true;
    resolveTerminal(event);
  };

  const terminal = new Promise<TerminalEvent>((resolve) => {
    resolveTerminal = resolve;
  });
  const close = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });

  child.stdout?.on('data', (chunk: Buffer<ArrayBufferLike>) => {
    if (terminalResolved) {
      return;
    }

    if (!stdoutStarted) {
      stdoutStarted = true;
      options.onFirstStdout();
    }
    stdoutBytes += chunk.length;
    payloadHash.update(chunk);
    evidenceBytes = appendEvidencePrefix(evidenceChunks, evidenceBytes, chunk);
    if (stdoutBytes > outputCapBytes) {
      resolveOnce({ type: 'output_cap' });
      child.stdout?.pause();
      return;
    }

    stdoutChunks.push(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer<ArrayBufferLike>) => {
    stderrTail.append(chunk);
  });
  child.once('error', (error) => resolveOnce({ type: 'spawn_error', error }));
  child.once('close', (exitCode) => resolveOnce({ type: 'close', exitCode }));
  child.stdin?.on('error', () => undefined);

  const timeout = setTimeout(() => resolveOnce({ type: 'timeout' }), timeoutMs);
  const abort = (): void => resolveOnce({ type: 'abort' });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted === true) {
    abort();
  }

  return {
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    },
    terminal,
    close,
    readStdout: () => Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
    readRawExcerpt: (forceTruncated = false) =>
      createStdoutExcerpt(evidenceChunks, stdoutBytes, evidenceBytes, payloadHash, forceTruncated),
    readStderrExcerpt: () => stderrTail.text(),
  };
};

const createAttemptDirectory = async (
  override: string | undefined,
  preserve: boolean,
): Promise<AttemptDirectory> => {
  if (override === undefined) {
    return { path: await mkdtemp(join(tmpdir(), 'attest-')), remove: true };
  }
  if (preserve) {
    await mkdir(override, { recursive: true });
    return { path: override, remove: false };
  }
  return { path: await mkdtemp(join(override, 'attempt-')), remove: true };
};

const resolveCliEnvironment = async (
  request: AgentRequest,
  attemptDirectory: string,
  options: InvokeOptions,
): Promise<Record<string, string>> => {
  await Promise.all([
    mkdir(join(attemptDirectory, 'home'), { recursive: true }),
    mkdir(join(attemptDirectory, 'tmp'), { recursive: true }),
  ]);
  // Explicit values are forwarded whole; otherwise only allowlisted host values cross over.
  const forwardedKeys =
    options.env === undefined ? (options.envAllowlist ?? []) : Object.keys(options.env);
  return resolveInvocationEnv(
    forwardedKeys,
    options.env ?? process.env,
    { runId: request.run_id, caseId: request.case_id },
    attemptDirectory,
  );
};

const describeProcessExit = (
  stderrExcerpt: string | undefined,
  unreapedProcessIds: readonly number[],
  exitCode: number | undefined,
): InvocationDiagnostics => ({
  stderrExcerpt,
  ...(exitCode === undefined ? {} : { exitCode }),
  ...(unreapedProcessIds.length === 0 ? {} : { unreapedProcessIds: [...unreapedProcessIds] }),
});

const sweepProcessTree = async (
  child: ChildProcess,
  close: Promise<void>,
  descendantSnapshots: readonly Promise<ProcessIdentity[]>[],
  terminationGraceMs: number,
  signalProcessGroup: boolean,
): Promise<number[]> => {
  const unreapedProcessIds = await killProcessTree(child, {
    graceMs: terminationGraceMs,
    initialDescendants: (await Promise.all(descendantSnapshots)).flat(),
    signalProcessGroup,
  });
  await close;
  return unreapedProcessIds;
};

/**
 * Performs one isolated CLI attempt under docs/specs/agent-contract.md. The invoker owns the fresh
 * cwd and applies the same best-effort identity-checked descendant sweep to every terminal path.
 */
const invokeCliAgent = async (
  target: Extract<NativeAgentTarget, { type: 'cli' }>,
  request: AgentRequest,
  options: InvokeOptions,
): Promise<InvocationAttempt> => {
  const duration = startTimer();
  const attemptDirectory = await createAttemptDirectory(
    options.workingDirectory,
    options.preserveWorkingDirectory ?? false,
  );
  let capture: InvocationCapture | undefined;

  try {
    const environment = await resolveCliEnvironment(request, attemptDirectory.path, options);
    const child = spawnInProcessGroup(target.command, {
      cwd: attemptDirectory.path,
      env: environment,
    });
    const { pid } = child;
    const descendantSnapshots: Promise<ProcessIdentity[]>[] = [
      pid === undefined ? Promise.resolve([]) : listDescendantProcesses(pid),
    ];
    capture = captureInvocation(child, {
      outputCapBytes: options.outputCapBytes,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      onFirstStdout: () => {
        if (pid !== undefined) descendantSnapshots.push(listDescendantProcesses(pid));
      },
    });

    child.stdin?.end(JSON.stringify(request));
    const terminal = await capture.terminal;
    const unreapedProcessIds = await sweepProcessTree(
      child,
      capture.close,
      descendantSnapshots,
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
      terminal.type !== 'close',
    );
    const diagnostics = describeProcessExit(
      capture.readStderrExcerpt(),
      unreapedProcessIds,
      terminal.type === 'close' ? (terminal.exitCode ?? undefined) : undefined,
    );
    const fail = (error: AgentInvocationError, rawExcerpt: RawExcerpt): InvocationAttempt =>
      createFailedAttempt(error, { diagnostics, durationMs: duration(), rawExcerpt });

    if (terminal.type === 'spawn_error') {
      return fail(
        new AgentInvocationError(
          'spawn_failed',
          `Failed to spawn CLI agent: ${terminal.error.message}`,
          { cause: terminal.error },
        ),
        capture.readRawExcerpt(),
      );
    }
    if (terminal.type === 'abort' || (terminal.type === 'timeout' && options.signal?.aborted)) {
      return fail(
        new AgentInvocationError('cancelled', 'CLI agent invocation was cancelled'),
        capture.readRawExcerpt(),
      );
    }
    if (terminal.type === 'timeout') {
      return fail(
        new AgentInvocationError('timeout', 'CLI agent invocation timed out'),
        capture.readRawExcerpt(),
      );
    }
    if (terminal.type === 'output_cap') {
      return fail(
        new AgentInvocationError(
          'output_cap_exceeded',
          `CLI agent stdout exceeded the ${options.outputCapBytes}-byte output cap`,
        ),
        capture.readRawExcerpt(true),
      );
    }

    const rawExcerpt = capture.readRawExcerpt();
    if (terminal.exitCode !== 0) {
      return fail(
        new AgentInvocationError(
          'nonzero_exit',
          `CLI agent exited with code ${String(terminal.exitCode)}`,
        ),
        rawExcerpt,
      );
    }

    try {
      return {
        status: 'ok',
        raw: JSON.parse(capture.readStdout()) as unknown,
        diagnostics,
        durationMs: duration(),
        rawExcerpt,
        warnings: [],
      };
    } catch (error) {
      return fail(
        new AgentInvocationError('invalid_envelope', 'CLI agent stdout was not valid JSON', {
          cause: error,
        }),
        rawExcerpt,
      );
    }
  } finally {
    capture?.cleanup();
    if (attemptDirectory.remove) {
      await rm(attemptDirectory.path, { recursive: true, force: true });
    }
  }
};

export { invokeCliAgent };
