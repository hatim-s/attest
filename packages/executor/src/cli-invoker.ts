import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Option from 'effect/Option';
import { parseJson } from './internal/json-value.js';
import type { AgentRequest, RawExcerpt } from '@attest/contracts';
import type { ChildProcess } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentInvocationError, abortedError } from './errors.js';
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
  expire: () => void;
  close: Deferred.Deferred<void>;
  terminal: Deferred.Deferred<TerminalEvent>;
  firstStdout: Deferred.Deferred<void>;
  readRawExcerpt: (forceTruncated?: boolean) => RawExcerpt;
  readStderrExcerpt: () => string | undefined;
  readStdout: () => string;
};

type AttemptDirectory = { path: string; remove: boolean };

type CaptureOptions = {
  outputCapBytes: number;
  signal: AbortSignal | undefined;
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

/** Captures bounded bytes and publishes one-time receipts without starting native operations. */
const captureInvocation = (child: ChildProcess, options: CaptureOptions): InvocationCapture => {
  const { outputCapBytes, signal } = options;
  const stdoutChunks: Buffer<ArrayBufferLike>[] = [];
  const evidenceChunks: Uint8Array[] = [];
  const payloadHash = createHash('sha256');
  let stdoutBytes = 0;
  let evidenceBytes = 0;
  const stderrTail = new BoundedTail(STDERR_EXCERPT_BYTES);
  let terminalResolved = false;
  let stdoutStarted = false;
  const terminal = Deferred.makeUnsafe<TerminalEvent>();
  const close = Deferred.makeUnsafe<void>();
  const firstStdout = Deferred.makeUnsafe<void>();

  const resolveOnce = (event: TerminalEvent): void => {
    if (terminalResolved) return;
    terminalResolved = true;
    Deferred.doneUnsafe(terminal, Effect.succeed(event));
  };

  const acknowledgeClose = (): void => {
    Deferred.doneUnsafe(close, Effect.void);
  };

  child.once('close', acknowledgeClose);

  const stdout = (chunk: Buffer<ArrayBufferLike>): void => {
    if (terminalResolved) {
      return;
    }

    if (!stdoutStarted) {
      stdoutStarted = true;
      Deferred.doneUnsafe(firstStdout, Effect.void);
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
  };

  const stderr = (chunk: Buffer<ArrayBufferLike>): void => {
    stderrTail.append(chunk);
  };

  const error = (error: Error): void => resolveOnce({ type: 'spawn_error', error });
  const closed = (exitCode: number | null): void => resolveOnce({ type: 'close', exitCode });
  const stdinError = (): void => undefined;
  child.stdout?.on('data', stdout);
  child.stderr?.on('data', stderr);
  child.once('error', error);
  child.once('close', closed);
  child.stdin?.on('error', stdinError);

  const abort = (): void => resolveOnce({ type: 'abort' });
  signal?.addEventListener('abort', abort, { once: true });

  if (signal?.aborted === true) {
    abort();
  }

  return {
    cleanup: () => {
      signal?.removeEventListener('abort', abort);
      child.stdout?.off('data', stdout);
      child.stderr?.off('data', stderr);
      child.off('close', acknowledgeClose);
      child.off('close', closed);
      // Keep error sinks until destroyed streams settle, including a missing close acknowledgement.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
    expire: () => resolveOnce({ type: 'timeout' }),
    terminal,
    close,
    firstStdout,
    readStdout: () => Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
    readRawExcerpt: (forceTruncated = false) =>
      createStdoutExcerpt(evidenceChunks, stdoutBytes, evidenceBytes, payloadHash, forceTruncated),
    readStderrExcerpt: () => stderrTail.text(),
  };
};

/** Identifies acquisition or cleanup failures without disguising defects as attempts. */
class CliInfrastructureError extends Data.TaggedError('CliInfrastructureError')<{
  operation:
    | 'create_directory'
    | 'create_environment'
    | 'remove_directory'
    | 'verify_process_cleanup'
    | 'await_close';
  cause: unknown;
}> {}

/** Retains cleanup causes and any completed attempt when resource release is unconfirmed. */
class CliCleanupError extends Data.TaggedError('CliCleanupError')<{
  causes: readonly Cause.Cause<CliInfrastructureError>[];
  attempt?: InvocationAttempt;
}> {}

/** Attaches owned release diagnostics without replacing the primary failure or interruption. */
class CliCleanupDiagnostics extends Context.Service<
  CliCleanupDiagnostics,
  { causes: readonly Cause.Cause<CliInfrastructureError>[] }
>()('attest/executor/CliCleanupDiagnostics') {}

/** Keeps directory release diagnostics separate from nested child release diagnostics. */
class CliDirectoryCleanupDiagnostics extends Context.Service<
  CliDirectoryCleanupDiagnostics,
  Cause.Cause<CliInfrastructureError>
>()('attest/executor/CliDirectoryCleanupDiagnostics') {}

/** Acquires a fresh attempt cwd, or creates the caller-owned shared cwd without owning its removal. */
const createAttemptDirectory = Effect.fn('cli.createAttemptDirectory')(function* (
  shared: string | undefined,
) {
  if (shared === undefined) {
    const path = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), 'attest-')),
      catch: (cause) => new CliInfrastructureError({ operation: 'create_directory', cause }),
    });

    return { path, remove: true };
  }

  yield* Effect.tryPromise({
    try: () => mkdir(shared, { recursive: true }),
    catch: (cause) => new CliInfrastructureError({ operation: 'create_directory', cause }),
  });

  return { path: shared, remove: false };
});

/** Creates both isolated environment directories before resolving the synchronous environment policy. */
const resolveCliEnvironment = Effect.fn('cli.resolveEnvironment')(function* (
  request: AgentRequest,
  attemptDirectory: string,
  options: InvokeOptions,
) {
  for (const name of ['home', 'tmp']) {
    yield* Effect.tryPromise({
      try: () => mkdir(join(attemptDirectory, name), { recursive: true }),
      catch: (cause) => new CliInfrastructureError({ operation: 'create_environment', cause }),
    });
  }

  return resolveInvocationEnv(
    Object.keys(options.env ?? {}),
    options.env ?? process.env,
    { runId: request.run_id, caseId: request.case_id },
    attemptDirectory,
  );
});

const describeProcessExit = (
  stderrExcerpt: string | undefined,
  unreapedProcessIds: readonly number[],
  exitCode: number | undefined,
): InvocationDiagnostics => {
  const diagnostics: InvocationDiagnostics = { stderrExcerpt };

  if (exitCode !== undefined) diagnostics.exitCode = exitCode;

  if (unreapedProcessIds.length > 0) diagnostics.unreapedProcessIds = [...unreapedProcessIds];

  return diagnostics;
};

/**
 * Owns one child through terminal observation, snapshot joins, identity-checked termination and
 * close acknowledgement. Callbacks publish receipts; only the native owner starts observations.
 */
const runCliChild = Effect.fn('cli.runChild')(function* (
  target: Extract<NativeAgentTarget, { type: 'cli' }>,
  request: AgentRequest,
  options: InvokeOptions,
  directory: string,
  environment: Record<string, string>,
  duration: () => number,
) {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const child = spawnInProcessGroup(target.command, { cwd: directory, env: environment });

      const capture = captureInvocation(child, {
        outputCapBytes: options.outputCapBytes,
        signal: options.signal,
      });

      const snapshots: ProcessIdentity[] = [];
      let observationsAvailable = true;

      const snapshot = Effect.gen(function* () {
        if (child.pid === undefined) return;
        const observed = yield* listDescendantProcesses(child.pid);
        snapshots.push(...observed.identities);
        observationsAvailable = observationsAvailable && observed.available;
      });

      const initial = yield* Effect.forkChild(snapshot, { uninterruptible: true });

      const firstOutput = yield* Effect.forkChild(
        Effect.gen(function* () {
          // Racing observations does not discard an attempt. A requested snapshot is joined below.
          const requested = yield* Effect.raceFirst(
            Deferred.await(capture.firstStdout).pipe(Effect.as(true), Effect.interruptible),
            Deferred.await(capture.terminal).pipe(Effect.as(false), Effect.interruptible),
          );

          if (requested || Deferred.isDoneUnsafe(capture.firstStdout)) yield* snapshot;
        }),
        { uninterruptible: true },
      );

      const deadline = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Effect.sleep(options.timeoutMs);
          capture.expire();
        }),
        { uninterruptible: false },
      );

      const primary = yield* Effect.exit(
        restore(
          Effect.gen(function* () {
            child.stdin?.end(JSON.stringify(request));

            return yield* Deferred.await(capture.terminal);
          }),
        ),
      );

      // Teardown wakes an unrequested snapshot observer even when no terminal callback arrived.
      if (Exit.isFailure(primary)) Deferred.doneUnsafe(capture.firstStdout, Effect.void);
      yield* Fiber.interrupt(deadline);
      const causes: Cause.Cause<CliInfrastructureError>[] = [];

      // Each release step captures its full Exit so one failed step cannot skip the next.
      for (const fiber of [initial, firstOutput]) {
        const joined = yield* Effect.exit(Fiber.join(fiber));

        if (Exit.isFailure(joined)) causes.push(joined.cause);
      }

      const swept = yield* Effect.exit(
        killProcessTree(child, {
          graceMs: options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
          initialDescendants: snapshots,
          initialObservationAvailable: observationsAvailable,
          signalProcessGroup: Exit.isFailure(primary) || primary.value.type !== 'close',
        }),
      );

      if (Exit.isFailure(swept)) causes.push(swept.cause);
      else if (!swept.value.cleanupConfirmed) {
        causes.push(
          Cause.fail(
            new CliInfrastructureError({
              operation: 'verify_process_cleanup',
              cause: swept.value,
            }),
          ),
        );
      }

      const closed = yield* Effect.exit(
        Effect.timeoutOption(Effect.interruptible(Deferred.await(capture.close)), 1000),
      );

      if (Exit.isFailure(closed)) causes.push(closed.cause);
      else if (Option.isNone(closed.value)) {
        causes.push(
          Cause.fail(
            new CliInfrastructureError({
              operation: 'await_close',
              cause: 'CLI child close acknowledgement was not received',
            }),
          ),
        );
      }

      const detached = yield* Effect.exit(Effect.sync(capture.cleanup));

      if (Exit.isFailure(detached)) causes.push(detached.cause);

      if (Exit.isFailure(primary)) {
        return yield* Effect.failCause(
          Cause.annotate(primary.cause, Context.make(CliCleanupDiagnostics, { causes })),
        );
      }

      const terminal = primary.value;

      const unreapedProcessIds = Exit.isSuccess(swept)
        ? swept.value.unreapedProcessIds
        : snapshots.map((item) => item.processId);

      const attempt = classifyAttempt(terminal, capture, options, unreapedProcessIds, duration);

      if (causes.length > 0) return yield* Effect.fail(new CliCleanupError({ causes, attempt }));

      return attempt;
    }),
  );
});

/** Selects transport evidence synchronously after the child owner has joined cleanup. */
const classifyAttempt = (
  terminal: TerminalEvent,
  capture: InvocationCapture,
  options: InvokeOptions,
  unreapedProcessIds: readonly number[],
  duration: () => number,
): InvocationAttempt => {
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

  if (terminal.type === 'abort' || terminal.type === 'timeout') {
    return fail(abortedError(options.signal, 'CLI agent invocation'), capture.readRawExcerpt());
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
      raw: parseJson(capture.readStdout()),
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
};

/** Owns the attempt directory outside the child lifetime and preserves primary Causes on release. */
const invokeCliAgent = Effect.fn('cli.invokeAgent')(function* (
  target: Extract<NativeAgentTarget, { type: 'cli' }>,
  request: AgentRequest,
  options: InvokeOptions,
) {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const duration = startTimer();
      const directory: AttemptDirectory = yield* createAttemptDirectory(options.workingDirectory);

      const primary = yield* Effect.exit(
        restore(
          Effect.gen(function* () {
            const environment = yield* Effect.uninterruptible(
              resolveCliEnvironment(request, directory.path, options),
            );

            return yield* runCliChild(
              target,
              request,
              options,
              directory.path,
              environment,
              duration,
            );
          }),
        ),
      );

      const cleanup = yield* Effect.exit(
        directory.remove
          ? Effect.tryPromise({
              try: () => rm(directory.path, { recursive: true, force: true }),
              catch: (cause) =>
                new CliInfrastructureError({ operation: 'remove_directory', cause }),
            })
          : Effect.void,
      );

      if (Exit.isFailure(primary)) {
        return yield* Effect.failCause(
          Exit.isFailure(cleanup)
            ? Cause.annotate(
                primary.cause,
                Context.make(CliDirectoryCleanupDiagnostics, cleanup.cause),
              )
            : primary.cause,
        );
      }

      if (Exit.isFailure(cleanup)) {
        return yield* Effect.fail(
          new CliCleanupError({ causes: [cleanup.cause], attempt: primary.value }),
        );
      }

      return primary.value;
    }),
  );
});

export { invokeCliAgent, CliCleanupError };
