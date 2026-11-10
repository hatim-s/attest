import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { finishWithRelease } from '../../internal/lifecycle-cause.js';
import {
  killProcessTree,
  listDescendantProcesses,
  spawnInProcessGroup,
  type ProcessSnapshot,
} from '@attest/executor';

import { LocalError } from '../../errors/index.js';

const HOOK_TERMINATION_GRACE_MS = 1_000;

type HookCommand = { argv: readonly string[]; timeout_ms?: number };

type HookPhase =
  'after_agent' | 'after_evaluation' | 'after_case' | 'after_run' | 'before_case' | 'before_run';

class HookCommandError extends LocalError {
  readonly cleanupConfirmed: boolean;

  constructor(message: string, cleanupConfirmed = true) {
    super('run_failed', message);
    this.name = 'HookCommandError';
    this.cleanupConfirmed = cleanupConfirmed;
  }
}

/**
 * Reads the abort flag through a call so TypeScript does not keep the narrowing from an earlier
 * check; the signal can abort while the hook spawns.
 */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/** Runs one argv-only hook with identity-checked process-tree cleanup on every terminal path. */
const runHookCommand = Effect.fn('runHookCommand')(function* (options: {
  command: HookCommand;
  cwd: string;
  env: Record<string, string>;
  phase: HookPhase;
  signal?: AbortSignal;
  timeoutMs: number;
}) {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const [file, ...argumentsList] = options.command.argv;

      if (file === undefined) return;

      if (isAborted(options.signal)) {
        return yield* Effect.fail(new HookCommandError(`Eval ${options.phase} hook was aborted.`));
      }

      const child = spawnInProcessGroup([file, ...argumentsList], {
        cwd: options.cwd,
        env: options.env,
      });

      child.stdin?.end();
      child.stdout?.resume();
      child.stderr?.resume();

      const descendantSnapshots: ProcessSnapshot[] = [];

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

      if (child.pid !== undefined) {
        descendantSnapshots.push(yield* listDescendantProcesses(child.pid));
      }

      const primary = yield* Effect.exit(restore(Effect.promise(() => terminal)));
      const result: Terminal = Exit.isSuccess(primary) ? primary.value : { type: 'abort' };
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);

      if (child.pid !== undefined && result.type !== 'close') {
        descendantSnapshots.push(yield* listDescendantProcesses(child.pid));
      }

      const snapshots = descendantSnapshots;

      const cleanupExit = yield* Effect.exit(
        killProcessTree(child, {
          graceMs: HOOK_TERMINATION_GRACE_MS,
          initialDescendants: snapshots.flatMap((snapshot) => snapshot.identities),
          initialObservationAvailable: snapshots.every((snapshot) => snapshot.available),
          signalProcessGroup: result.type !== 'close',
        }),
      );

      yield* Effect.promise(() => close);

      if (Exit.isFailure(primary)) return yield* finishWithRelease(primary, [cleanupExit]);

      if (Exit.isFailure(cleanupExit)) return yield* cleanupExit;
      const cleanupConfirmed = cleanupExit.value.cleanupConfirmed;

      const cleanupSuffix = cleanupConfirmed ? '' : ' Process cleanup could not be confirmed.';

      if (result.type === 'timeout')
        return yield* Effect.fail(
          new HookCommandError(
            `Eval ${options.phase} hook timed out.${cleanupSuffix}`,
            cleanupConfirmed,
          ),
        );

      if (result.type === 'abort')
        return yield* Effect.fail(
          new HookCommandError(
            `Eval ${options.phase} hook was aborted.${cleanupSuffix}`,
            cleanupConfirmed,
          ),
        );

      if (result.type === 'spawn_error')
        return yield* Effect.fail(
          new HookCommandError(`Eval ${options.phase} hook could not start.`),
        );

      if (result.exitCode !== 0) {
        return yield* Effect.fail(
          new HookCommandError(
            `Eval ${options.phase} hook exited with code ${String(result.exitCode)}.${cleanupSuffix}`,
            cleanupConfirmed,
          ),
        );
      }

      if (!cleanupConfirmed)
        return yield* Effect.fail(
          new HookCommandError(
            `Eval ${options.phase} hook process cleanup could not be confirmed.`,
            false,
          ),
        );
    }),
  );
});

export { HookCommandError, runHookCommand, type HookCommand, type HookPhase };
