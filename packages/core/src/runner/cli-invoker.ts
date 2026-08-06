import type { AgentRequest, AgentTarget, RawExcerpt } from '@attest/contracts';
import type { ChildProcess } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentInvocationError, type InvocationErrorCode } from './errors.js';
import { startTimer } from './internal/elapsed.js';
import { createRawExcerpt as createPayloadRawExcerpt } from './internal/raw-excerpt.js';
import {
  killProcessTree,
  listDescendantProcesses,
  spawnInProcessGroup,
  type ProcessIdentity,
} from './internal/process-tree.js';
import { resolveInvocationEnv } from './request.js';
import type { InvocationAttempt, InvocationDiagnostics, InvokeOptions } from './types.js';

const STDERR_EXCERPT_BYTES = 4096;
const RAW_EXCERPT_CHARACTERS = 4096;
const RAW_EVIDENCE_PREFIX_BYTES = RAW_EXCERPT_CHARACTERS * 4;
const TERMINATION_GRACE_MS = 5000;

type CliInvokeOptions = Omit<InvokeOptions, 'env'> & {
  env?: Record<string, string>;
  envAllowlist?: readonly string[];
};

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

const createInvocationError = (
  code: InvocationErrorCode,
  message: string,
  diagnostics: InvocationDiagnostics,
  duration: () => number,
  rawExcerpt: RawExcerpt,
  cause?: Error,
): InvocationAttempt => {
  const errorOptions = cause === undefined ? undefined : { cause };
  return {
    status: 'invocation_error',
    error: new AgentInvocationError(code, message, errorOptions),
    diagnostics,
    durationMs: duration(),
    rawExcerpt,
    warnings: [],
  };
};

const appendStderr = (
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
): Buffer<ArrayBufferLike> => {
  const combined = Buffer.concat([current, chunk]);
  return combined.subarray(Math.max(0, combined.length - STDERR_EXCERPT_BYTES));
};

const appendEvidencePrefix = (
  chunks: Buffer<ArrayBufferLike>[],
  byteCount: number,
  chunk: Buffer<ArrayBufferLike>,
): number => {
  const remainingBytes = Math.max(0, RAW_EVIDENCE_PREFIX_BYTES - byteCount);
  if (remainingBytes === 0) {
    return byteCount;
  }

  const retained = chunk.subarray(0, remainingBytes);
  chunks.push(retained);
  return byteCount + retained.length;
};

/** Preserves a valid UTF-8 stderr tail at the 4 KB diagnostics boundary. */
const decodeUtf8Tail = (buffer: Buffer<ArrayBufferLike>, maxBytes: number): string => {
  const tail = buffer.subarray(Math.max(0, buffer.length - maxBytes));
  let startOffset = 0;
  // UTF-8 continuation bytes cannot begin a valid code point, so discard only the split prefix.
  while (startOffset < tail.length) {
    const leadingByte = tail[startOffset];
    if (leadingByte === undefined || (leadingByte & 0xc0) !== 0x80) {
      break;
    }

    startOffset += 1;
  }

  return tail.subarray(startOffset).toString('utf8');
};

const createRawExcerpt = (
  evidenceChunks: readonly Buffer<ArrayBufferLike>[],
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
  const rawExcerpt = createPayloadRawExcerpt(evidence);
  return truncated
    ? { ...rawExcerpt, truncated: true, sha256: payloadHash.digest('hex') }
    : rawExcerpt;
};

const captureInvocation = (
  child: ChildProcess,
  outputCapBytes: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onStdout: () => void,
): InvocationCapture => {
  const stdoutChunks: Buffer<ArrayBufferLike>[] = [];
  const evidenceChunks: Buffer<ArrayBufferLike>[] = [];
  const payloadHash = createHash('sha256');
  let stdoutBytes = 0;
  let evidenceBytes = 0;
  let stderrExcerpt: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let terminalResolved = false;
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

    onStdout();
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
    stderrExcerpt = appendStderr(stderrExcerpt, chunk);
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
      createRawExcerpt(evidenceChunks, stdoutBytes, evidenceBytes, payloadHash, forceTruncated),
    readStderrExcerpt: () =>
      stderrExcerpt.length === 0 ? undefined : decodeUtf8Tail(stderrExcerpt, STDERR_EXCERPT_BYTES),
  };
};

const createAttemptDirectory = async (override: string | undefined): Promise<AttemptDirectory> => {
  return override === undefined
    ? { path: await mkdtemp(join(tmpdir(), 'attest-')), remove: true }
    : { path: override, remove: false };
};

const resolveCliEnvironment = async (
  request: AgentRequest,
  attemptDirectory: string,
  options: CliInvokeOptions,
): Promise<Record<string, string>> => {
  if (options.env !== undefined) {
    return options.env;
  }

  const homeDirectory = join(attemptDirectory, 'home');
  const temporaryDirectory = join(attemptDirectory, 'tmp');
  await Promise.all([
    mkdir(homeDirectory, { recursive: true }),
    mkdir(temporaryDirectory, { recursive: true }),
  ]);
  const environment = resolveInvocationEnv(
    options.envAllowlist,
    process.env,
    { runId: request.run_id, caseId: request.case_id },
    attemptDirectory,
  );
  return environment;
};

const withUnreapedDiagnostics = (
  stderrExcerpt: string | undefined,
  unreapedProcessIds: readonly number[],
  exitCode?: number,
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
): Promise<number[]> => {
  const unreapedProcessIds = await killProcessTree(child, {
    graceMs: terminationGraceMs,
    initialDescendants: (await Promise.all(descendantSnapshots)).flat(),
  });
  await close;
  return unreapedProcessIds;
};

/**
 * Performs one isolated CLI attempt under docs/specs/agent-contract.md. The invoker owns the fresh
 * cwd and applies the same identity-safe descendant sweep to every terminal transport path.
 */
const invokeCliAgent = async (
  target: Extract<AgentTarget, { type: 'cli' }>,
  request: AgentRequest,
  options: CliInvokeOptions,
): Promise<InvocationAttempt> => {
  const duration = startTimer();
  const attemptDirectory = await createAttemptDirectory(options.workingDirectory);
  let capture: InvocationCapture | undefined;

  try {
    const environment = await resolveCliEnvironment(request, attemptDirectory.path, options);
    const requestDocument = JSON.stringify(request);
    const child = spawnInProcessGroup(target.command, {
      cwd: attemptDirectory.path,
      env: environment,
    });
    const descendantSnapshots = [
      child.pid === undefined ? Promise.resolve([]) : listDescendantProcesses(child.pid),
    ];
    let stdoutSnapshotStarted = false;
    capture = captureInvocation(
      child,
      options.outputCapBytes,
      options.signal,
      options.timeoutMs,
      () => {
        if (!stdoutSnapshotStarted && child.pid !== undefined) {
          stdoutSnapshotStarted = true;
          descendantSnapshots.push(listDescendantProcesses(child.pid));
        }
      },
    );

    child.stdin?.end(requestDocument);
    const terminal = await capture.terminal;
    const unreapedProcessIds = await sweepProcessTree(
      child,
      capture.close,
      descendantSnapshots,
      options.terminationGraceMs ?? TERMINATION_GRACE_MS,
    );
    const stderrExcerpt = capture.readStderrExcerpt();
    const diagnostics = withUnreapedDiagnostics(stderrExcerpt, unreapedProcessIds);

    if (terminal.type === 'spawn_error') {
      return createInvocationError(
        'spawn_failed',
        `Failed to spawn CLI agent: ${terminal.error.message}`,
        diagnostics,
        duration,
        capture.readRawExcerpt(),
        terminal.error,
      );
    }

    if (terminal.type === 'timeout' || terminal.type === 'abort') {
      const cancelled = terminal.type === 'abort' || options.signal?.aborted === true;
      return createInvocationError(
        cancelled ? 'cancelled' : 'timeout',
        cancelled ? 'CLI agent invocation was cancelled' : 'CLI agent invocation timed out',
        diagnostics,
        duration,
        capture.readRawExcerpt(),
      );
    }

    if (terminal.type === 'output_cap') {
      return createInvocationError(
        'output_cap_exceeded',
        `CLI agent stdout exceeded the ${options.outputCapBytes}-byte output cap`,
        diagnostics,
        duration,
        capture.readRawExcerpt(true),
      );
    }

    const rawExcerpt = capture.readRawExcerpt();
    const exitDiagnostics = withUnreapedDiagnostics(
      stderrExcerpt,
      unreapedProcessIds,
      terminal.exitCode ?? undefined,
    );
    if (terminal.exitCode !== 0) {
      return createInvocationError(
        'nonzero_exit',
        `CLI agent exited with code ${String(terminal.exitCode)}`,
        exitDiagnostics,
        duration,
        rawExcerpt,
      );
    }

    const stdout = capture.readStdout();
    try {
      return {
        status: 'ok',
        raw: JSON.parse(stdout) as unknown,
        diagnostics: exitDiagnostics,
        durationMs: duration(),
        rawExcerpt,
        warnings: [],
      };
    } catch (error) {
      return createInvocationError(
        'invalid_envelope',
        'CLI agent stdout was not valid JSON',
        exitDiagnostics,
        duration,
        rawExcerpt,
        error instanceof Error ? error : undefined,
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
