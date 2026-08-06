import type { AgentRequest, AgentTarget } from '@attest/contracts';
import type { ChildProcess } from 'node:child_process';

import { AgentInvocationError, type InvocationErrorCode } from './errors.js';
import { killProcessTree, spawnInProcessGroup } from './internal/process-tree.js';
import type { InvocationAttempt, InvocationDiagnostics, InvokeOptions } from './types.js';

const STDERR_EXCERPT_BYTES = 4096;
const TERMINATION_GRACE_MS = 5000;

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
  readStderrExcerpt: () => string | undefined;
  readStdout: () => string;
};

const calculateDuration = (startedAt: number): number => {
  return Math.max(0, performance.now() - startedAt);
};

const createInvocationError = (
  code: InvocationErrorCode,
  message: string,
  diagnostics: InvocationDiagnostics,
  startedAt: number,
  cause?: Error,
): InvocationAttempt => {
  const errorOptions = cause === undefined ? undefined : { cause };
  return {
    status: 'invocation_error',
    error: new AgentInvocationError(code, message, errorOptions),
    diagnostics,
    durationMs: calculateDuration(startedAt),
  };
};

const appendStderr = (
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
): Buffer<ArrayBufferLike> => {
  const combined = Buffer.concat([current, chunk]);
  return combined.subarray(Math.max(0, combined.length - STDERR_EXCERPT_BYTES));
};

/**
 * Decodes the bounded diagnostic tail without introducing a replacement character at a
 * truncated UTF-8 boundary, preserving the CLI stderr rule in docs/specs/agent-contract.md
 * and the 4 KB diagnostic contract in types.ts.
 */
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

const captureInvocation = (
  child: ChildProcess,
  outputCapBytes: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): InvocationCapture => {
  const stdoutChunks: Buffer<ArrayBufferLike>[] = [];
  let stdoutBytes = 0;
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

    stdoutBytes += chunk.length;
    if (stdoutBytes > outputCapBytes) {
      // Resolve the cap breach before killing so no additional output is retained.
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

  const cleanup = (): void => {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  };

  return {
    cleanup,
    terminal,
    close,
    readStdout: () => Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
    readStderrExcerpt: () =>
      stderrExcerpt.length === 0 ? undefined : decodeUtf8Tail(stderrExcerpt, STDERR_EXCERPT_BYTES),
  };
};

const requireWorkingDirectory = (workingDirectory: string | undefined): string => {
  if (workingDirectory === undefined) {
    throw new TypeError('CLI invocation requires a working directory');
  }

  return workingDirectory;
};

const reapAfterTermination = async (
  child: ChildProcess,
  close: Promise<void>,
  terminationGraceMs: number,
): Promise<void> => {
  await killProcessTree(child, { graceMs: terminationGraceMs });
  await close;
};

/**
 * Performs exactly one CLI transport attempt under the timeout, process-tree,
 * and bounded-output semantics defined by docs/specs/agent-contract.md.
 */
const invokeCliAgent = async (
  target: Extract<AgentTarget, { type: 'cli' }>,
  request: AgentRequest,
  options: InvokeOptions,
): Promise<InvocationAttempt> => {
  const startedAt = performance.now();
  const workingDirectory = requireWorkingDirectory(options.workingDirectory);
  const requestDocument = JSON.stringify(request);
  const child = spawnInProcessGroup(target.command, { cwd: workingDirectory, env: options.env });
  const capture = captureInvocation(
    child,
    options.outputCapBytes,
    options.signal,
    options.timeoutMs,
  );

  try {
    // Agents may wait for EOF, so write one document and end stdin before awaiting output.
    child.stdin?.end(requestDocument);
    const terminal = await capture.terminal;
    const diagnostics = { stderrExcerpt: capture.readStderrExcerpt() };

    if (terminal.type === 'spawn_error') {
      await capture.close;
      return createInvocationError(
        'spawn_failed',
        `Failed to spawn CLI agent: ${terminal.error.message}`,
        diagnostics,
        startedAt,
        terminal.error,
      );
    }

    if (terminal.type === 'timeout' || terminal.type === 'abort') {
      await reapAfterTermination(
        child,
        capture.close,
        options.terminationGraceMs ?? TERMINATION_GRACE_MS,
      );
      // Caller cancellation wins when its signal and the deadline collide in either order.
      const cancelled = terminal.type === 'abort' || options.signal?.aborted === true;
      const code = cancelled ? 'cancelled' : 'timeout';
      const message =
        code === 'timeout'
          ? 'CLI agent invocation timed out'
          : 'CLI agent invocation was cancelled';
      return createInvocationError(
        code,
        message,
        { stderrExcerpt: capture.readStderrExcerpt() },
        startedAt,
      );
    }

    if (terminal.type === 'output_cap') {
      await reapAfterTermination(
        child,
        capture.close,
        options.terminationGraceMs ?? TERMINATION_GRACE_MS,
      );
      return createInvocationError(
        'output_cap_exceeded',
        `CLI agent stdout exceeded the ${options.outputCapBytes}-byte output cap`,
        { stderrExcerpt: capture.readStderrExcerpt() },
        startedAt,
      );
    }

    if (terminal.exitCode !== 0) {
      return createInvocationError(
        'nonzero_exit',
        `CLI agent exited with code ${String(terminal.exitCode)}`,
        { ...diagnostics, exitCode: terminal.exitCode ?? undefined },
        startedAt,
      );
    }

    const stdout = capture.readStdout();
    try {
      return {
        status: 'ok',
        raw: JSON.parse(stdout) as unknown,
        diagnostics: { ...diagnostics, exitCode: 0 },
        durationMs: calculateDuration(startedAt),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      return createInvocationError(
        'invalid_envelope',
        'CLI agent stdout was not valid JSON',
        { ...diagnostics, exitCode: 0 },
        startedAt,
        cause,
      );
    }
  } finally {
    capture.cleanup();
  }
};

export { decodeUtf8Tail, invokeCliAgent };
