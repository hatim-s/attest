import { Cause, Data, Deferred, Effect, Exit } from 'effect';
import { execFile, spawn } from 'node:child_process';
import { withCleanup } from '../runner/lifetime.js';
import { createLineFramer } from './line-framer.js';
import { parsePiRecord, type PiRecord } from './pi-records.js';

type PiProcessInput = {
  argv: readonly [string, ...string[]];
  cwd: string;
  env: Record<string, string>;
  message: string;
  signal: AbortSignal;
  timeoutMs: number;
  onRecord: (record: PiRecord) => void;
};

type PiProcessOutcome =
  | { kind: 'settled'; aborted: boolean }
  | { kind: 'handled' }
  | { kind: 'rejected'; message: string }
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null; stderr: string }
  | { kind: 'spawn_failed'; message: string }
  | { kind: 'protocol_error'; message: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

type PiProcessReason =
  | 'spawn_failed'
  | 'terminate_failed'
  | 'verify_failed'
  | 'snapshot_empty'
  | 'snapshot_malformed'
  | 'cleanup_unconfirmed';

const PI_PROCESS_MESSAGES = {
  spawn_failed: 'Pi spawn failed.',
  terminate_failed: 'Pi process-group termination failed.',
  verify_failed: 'Pi process-group verification failed.',
  snapshot_empty: 'Pi process-group snapshot was empty.',
  snapshot_malformed: 'Pi process-group snapshot was malformed.',
  cleanup_unconfirmed: 'Pi process-group cleanup unconfirmed.',
} as const satisfies Record<PiProcessReason, string>;

/** Spawning, signalling or verifying the Pi process group failed. */
class PiProcessError extends Data.TaggedError('PiProcessError')<{
  reason: PiProcessReason;
  cause?: unknown;
}> {
  override readonly message = PI_PROCESS_MESSAGES[this.reason];
}

/** Owns one process group. Callback leaves publish observations; native flow owns deadlines and teardown. */
const runPiProcess = ({ argv, cwd, env, message, signal, timeoutMs, onRecord }: PiProcessInput) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (signal.aborted) return { kind: 'cancelled' } as const;
      const terminal = yield* Deferred.make<PiProcessOutcome>();
      const closed = yield* Deferred.make<void>();
      const [command, ...args] = argv;

      const child = yield* Effect.try({
        try: () =>
          spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }),
        catch: (cause) => new PiProcessError({ reason: 'spawn_failed', cause }),
      });

      let concluded = false;

      const publish = (outcome: PiProcessOutcome) => {
        if (concluded) return;
        concluded = true;
        Deferred.doneUnsafe(terminal, Effect.succeed(outcome));
      };

      const framer = createLineFramer(16 * 1024 * 1024);
      let stderr = '';

      const abort = () => {
        publish({ kind: 'cancelled' });
      };

      signal.addEventListener('abort', abort, { once: true });

      if (signal.aborted) abort();
      child.stdout.on('data', (chunk: Buffer) => {
        if (concluded) return;
        const lines = framer.push(chunk);

        if (lines === undefined) {
          publish({
            kind: 'protocol_error',
            message: 'Pi wrote a stdout line over 16777216 bytes.',
          });

          return;
        }

        for (const line of lines) {
          if (concluded) return;
          const parsed = parsePiRecord(line);

          if (!parsed.ok) {
            publish({ kind: 'protocol_error', message: parsed.message });

            return;
          }

          const record = parsed.record;

          if (record === undefined) continue;

          try {
            onRecord(record);
          } catch (defect) {
            Deferred.doneUnsafe(terminal, Effect.die(defect));

            return;
          }

          if (record.type === 'agent_settled')
            publish({ kind: 'settled', aborted: record.aborted });

          if (record.type === 'response' && record.id === 'attest-prompt') {
            if (!record.success)
              publish({ kind: 'rejected', message: record.error ?? 'Pi rejected the prompt.' });
            else if (record.data?.disposition === 'handled') publish({ kind: 'handled' });
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-8192);
      });
      child.stdin.on('error', () => undefined);
      child.on('error', (error) => {
        publish({ kind: 'spawn_failed', message: error.message });
      });
      child.on('exit', (code, exitSignal) => {
        publish({ kind: 'exited', code, signal: exitSignal, stderr: stderr.trim() });
      });
      child.on('close', () => {
        Deferred.doneUnsafe(closed, Effect.void);
      });

      /** ESRCH confirms absence; other failures must remain cleanup evidence. */
      const kill = (killSignal: NodeJS.Signals) =>
        Effect.try({
          try: () => {
            if (child.pid === undefined) return;

            try {
              process.kill(-child.pid, killSignal);
            } catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
                throw error;
            }
          },
          catch: (cause) => new PiProcessError({ reason: 'terminate_failed', cause }),
        });

      const cleanup = Effect.gen(function* () {
        const killed = yield* Effect.exit(kill('SIGKILL'));
        const joined = yield* Effect.exit(Deferred.await(closed).pipe(Effect.timeout(2_000)));
        signal.removeEventListener('abort', abort);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();

        const verified = yield* Effect.exit(
          Effect.gen(function* () {
            if (child.pid === undefined) return;

            for (let probe = 0; probe < 10; probe++) {
              const rows = yield* Effect.tryPromise({
                try: () =>
                  new Promise<string>((resolve, reject) => {
                    execFile(
                      'ps',
                      ['-axo', 'pgid=,stat='],
                      { timeout: 1_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
                      (error, stdout) =>
                        error === null
                          ? resolve(stdout)
                          : reject(new Error('Pi group snapshot failed.', { cause: error })),
                    );
                  }),
                catch: (cause) => new PiProcessError({ reason: 'verify_failed', cause }),
              });

              if (rows.trim() === '')
                return yield* new PiProcessError({ reason: 'snapshot_empty' });

              // A zombie has exited and cannot execute tools. Signal 0 alone still finds it.
              let live = false;

              for (const row of rows.trim().split('\n')) {
                const [group, state, ...extra] = row.trim().split(/\s+/u);

                if (
                  group === undefined ||
                  !/^\d+$/u.test(group) ||
                  state === undefined ||
                  extra.length > 0
                )
                  return yield* new PiProcessError({ reason: 'snapshot_malformed' });

                if (Number(group) === child.pid && !state.startsWith('Z')) live = true;
              }

              if (!live) return;
              yield* Effect.sleep(25);
            }

            return yield* new PiProcessError({ reason: 'cleanup_unconfirmed' });
          }),
        );

        // Inference cannot widen the three exits' error channels to one union, so state it once.
        const exits: readonly Exit.Exit<void, PiProcessError | Cause.TimeoutError>[] = [
          killed,
          joined,
          verified,
        ];

        const failures = exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []));

        if (failures.length > 0) return yield* Effect.failCause(failures.reduce(Cause.combine));
      });

      return yield* withCleanup(
        restore(
          Effect.gen(function* () {
            child.stdin.write(
              `${JSON.stringify({ id: 'attest-prompt', type: 'prompt', message })}\n`,
            );
            const observed = yield* Deferred.await(terminal).pipe(Effect.timeoutOption(timeoutMs));

            const outcome =
              observed._tag === 'None' ? ({ kind: 'timeout' } as const) : observed.value;

            if (outcome.kind === 'settled' || outcome.kind === 'handled') {
              child.stdin.end();
              const grace = yield* Deferred.await(closed).pipe(Effect.timeoutOption(5_000));

              if (grace._tag === 'Some') return outcome;
            }

            yield* kill('SIGTERM');
            yield* Deferred.await(closed).pipe(Effect.timeoutOption(2_000));

            return outcome;
          }),
        ),
        cleanup,
        3_000,
      );
    }),
  );

export { runPiProcess, type PiProcessOutcome };
