import * as Effect from 'effect/Effect';
import * as Deferred from 'effect/Deferred';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import { ProcessCleanupError } from './process-cleanup.js';
import type { AgentRequest } from '@attest/contracts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';

import { AgentInvocationError } from '../../errors.js';
import {
  identityKey,
  killProcessTree,
  listDescendantProcesses,
  type ProcessIdentity,
} from '../../internal/process-tree.js';

type ManagedChildOptions = {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  stderrCapBytes: number;
};

type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };

/** Owns one detached process group and bounded stderr evidence for a run-scoped adapter. */
class ManagedChild {
  private readonly child: ChildProcessWithoutNullStreams;
  readonly exit = Deferred.makeUnsafe<ProcessExit>();
  private readonly stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private stderrTruncated = false;
  private descendants: ProcessIdentity[] = [];
  private observationsAvailable = true;

  private constructor(child: ChildProcessWithoutNullStreams, stderrCapBytes: number) {
    this.child = child;
    // A late EPIPE after an interrupted drain wait must not escape as an uncaught event.
    child.stdin.on('error', () => undefined);
    this.child.stderr.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, stderrCapBytes - this.stderrBytes);

      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        this.stderrChunks.push(retained);
        this.stderrBytes += retained.byteLength;
      }

      if (chunk.byteLength > remaining) this.stderrTruncated = true;
    });
    child.once('close', (code, signal) =>
      Deferred.doneUnsafe(this.exit, Effect.succeed({ code, signal })),
    );
  }

  /** Spawns argv directly, never through a shell, and waits for the OS spawn boundary. */
  static start = Effect.fn('ManagedChild.start')(function* (options: ManagedChildOptions) {
    const [executable, ...argumentsList] = options.argv;

    if (executable === undefined) throw new TypeError('Managed process argv cannot be empty.');

    const child = spawn(executable, argumentsList, {
      cwd: options.cwd,
      detached: true,
      env: options.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const managed = new ManagedChild(child, options.stderrCapBytes);
    yield* Effect.callback<void, AgentInvocationError>((resume) => {
      const resolve = (): void => resume(Effect.void);
      const reject = (error: AgentInvocationError): void => resume(Effect.fail(error));

      const spawned = (): void => {
        child.off('error', failed);
        resolve();
      };

      const failed = (error: Error): void => {
        child.off('spawn', spawned);
        reject(
          new AgentInvocationError('spawn_failed', 'Managed agent process failed to spawn.', {
            cause: error,
          }),
        );
      };

      child.once('spawn', spawned);
      child.once('error', failed);
    });
    // Later process errors are represented by stream/exit state and must not become uncaught events.
    child.on('error', () => undefined);

    return managed;
  }, Effect.uninterruptible);

  /** Agent stdout, where run-scoped adapters read protocol frames. */
  get stdout(): Readable {
    return this.child.stdout;
  }

  /** Agent stderr, for readiness patterns; bounded evidence is kept separately. */
  get stderr(): Readable {
    return this.child.stderr;
  }

  /** Exit code after a normal exit; null while running or after a signal. */
  get exitCode(): number | null {
    return this.child.exitCode;
  }

  /** False once the process exited or was killed by a signal. */
  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Writes one complete protocol frame while making backpressure cancellation-safe. */
  writeLine = Effect.fn('ManagedChild.writeLine')(function* (
    this: ManagedChild,
    value:
      | { type: 'request'; request_id: string; request: AgentRequest }
      | { type: 'cancel'; request_id: string },
    signal?: AbortSignal,
  ) {
    if (signal?.aborted === true) {
      return yield* Effect.fail(
        new AgentInvocationError('cancelled', 'Managed agent stdin write was cancelled.'),
      );
    }

    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      return yield* Effect.fail(
        new AgentInvocationError('network', 'Managed agent stdin is unavailable.'),
      );
    }

    const accepted = yield* Effect.try({
      try: () => this.child.stdin.write(`${JSON.stringify(value)}\n`, 'utf8'),
      catch: (cause) =>
        new AgentInvocationError('network', 'Managed agent stdin write failed.', { cause }),
    });

    if (accepted) return;
    yield* Effect.callback<void, AgentInvocationError>((resume) => {
      const resolve = (): void => resume(Effect.void);
      const reject = (error: AgentInvocationError): void => resume(Effect.fail(error));
      let settled = false;

      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        this.child.stdin.off('drain', drained);
        this.child.stdin.off('error', failed);
        this.child.stdin.off('close', closed);
        signal?.removeEventListener('abort', aborted);
        operation();
      };

      const drained = (): void => finish(resolve);

      const failed = (error: Error): void =>
        finish(() =>
          reject(
            new AgentInvocationError('network', 'Managed agent stdin write failed.', {
              cause: error,
            }),
          ),
        );

      const closed = (): void =>
        finish(() =>
          reject(new AgentInvocationError('network', 'Managed agent stdin closed during write.')),
        );

      const aborted = (): void =>
        finish(() =>
          reject(new AgentInvocationError('cancelled', 'Managed agent stdin write was cancelled.')),
        );

      this.child.stdin.once('drain', drained);
      this.child.stdin.once('error', failed);
      this.child.stdin.once('close', closed);
      signal?.addEventListener('abort', aborted, { once: true });

      if (signal?.aborted === true) aborted();

      return Effect.sync(() => finish(() => undefined));
    });
  });

  /** Captures descendants before a graceful stop so daemonized children remain cleanup targets. */
  snapshotDescendants = Effect.fn('ManagedChild.snapshotDescendants')(function* (
    this: ManagedChild,
  ) {
    const processId = this.child.pid;

    if (processId === undefined) return;
    const discovered = yield* listDescendantProcesses(processId);
    const retained = new Map(this.descendants.map((identity) => [identityKey(identity), identity]));

    this.observationsAvailable = this.observationsAvailable && discovered.available;

    for (const identity of discovered.identities) retained.set(identityKey(identity), identity);
    // Graceful shutdown can reparent descendants; never discard the pre-shutdown snapshot.
    this.descendants = [...retained.values()];
  });

  /** Returns bounded stderr text; callers redact runtime secrets before persistence. */
  stderrExcerpt(): string | undefined {
    if (this.stderrBytes === 0) return undefined;
    const suffix = this.stderrTruncated ? '\n[stderr truncated]' : '';

    return `${Buffer.concat(this.stderrChunks, this.stderrBytes).toString('utf8')}${suffix}`;
  }

  /** Applies TERM/grace/KILL to the owned group and verifies known descendants. */
  terminate = Effect.fn('ManagedChild.terminate')(function* (this: ManagedChild, graceMs: number) {
    const snapshot = yield* Effect.exit(this.snapshotDescendants());

    const swept = yield* Effect.exit(
      killProcessTree(this.child, {
        graceMs,
        initialDescendants: this.descendants,
        initialObservationAvailable: this.observationsAvailable && Exit.isSuccess(snapshot),
        signalProcessGroup: this.running,
      }),
    );

    // A signal receipt alone does not confirm the direct child's stream/exit lifetime ended.
    const closed = yield* Effect.exit(
      Deferred.await(this.exit).pipe(Effect.interruptible, Effect.timeoutOption(1_000)),
    );

    if (Exit.isFailure(snapshot) || Exit.isFailure(swept) || Exit.isFailure(closed))
      return yield* Effect.fail(new ProcessCleanupError([snapshot, swept, closed]));

    if (!swept.value.cleanupConfirmed || Option.isNone(closed.value))
      return yield* Effect.fail(
        new AgentInvocationError('network', 'Managed process cleanup could not be confirmed.', {
          applicationStarted: true,
          cause: { cleanup: swept.value, closed: closed.value },
        }),
      );

    return swept.value.unreapedProcessIds;
  }, Effect.uninterruptible);
}

export { ManagedChild, type ManagedChildOptions, type ProcessExit };
