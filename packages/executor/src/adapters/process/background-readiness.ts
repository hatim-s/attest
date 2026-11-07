import * as Effect from 'effect/Effect';
import * as Deferred from 'effect/Deferred';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import { ProcessCleanupError } from './process-cleanup.js';
import { connect } from 'node:net';

import { AgentInvocationError } from '../../errors.js';
import type { BackgroundAgentResource } from './background-adapter.js';
import { assertLoopbackUrl, loopbackHost } from './loopback-url.js';
import type { ManagedChild } from './managed-child.js';

const READINESS_INTERVAL_MS = 50;

const READINESS_BUFFER_CHARACTERS = 16 * 1024;

type ReadinessWait = {
  process: ManagedChild;
  signal: AbortSignal;
  abortError: () => AgentInvocationError;
  cleanupExits: Exit.Exit<unknown, unknown>[];
};

type Readiness = BackgroundAgentResource['transport']['readiness'];

/** Captures callback detach and socket cleanup defects in the readiness owner's evidence. */
const releaseObservation = <A, E>(wait: ReadinessWait, release: Effect.Effect<A, E>) =>
  Effect.exit(release).pipe(
    Effect.map((exit) => {
      wait.cleanupExits.push(exit);
    }),
  );

/** Probes one socket and releases every listener on completion or interruption. */
const tcpReady = (host: string, port: number, wait: ReadinessWait) =>
  Effect.gen(function* () {
    if (!loopbackHost(host)) return false;
    const observed = yield* Deferred.make<boolean>();
    const connected = () => Deferred.doneUnsafe(observed, Effect.succeed(true));
    const failed = () => Deferred.doneUnsafe(observed, Effect.succeed(false));

    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const socket = connect({ host, port });
        socket.once('connect', connected);
        socket.once('error', failed);

        return socket;
      }),
      () => Deferred.await(observed),
      (socket) =>
        releaseObservation(
          wait,
          Effect.sync(() => {
            socket.off('connect', connected);
            socket.off('error', failed);
            socket.destroy();
          }),
        ),
    );
  });

/** Owns the fetch and body release independently so cleanup failures cannot escape observation. */
const httpReady = (endpoint: URL, wait: ReadinessWait) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const response = yield* restore(
        Effect.tryPromise({
          try: (signal) => fetch(endpoint, { redirect: 'manual', signal }),
          catch: (cause) =>
            new AgentInvocationError('network', 'Readiness probe failed.', { cause }),
        }).pipe(Effect.catch(() => Effect.succeed(undefined))),
      );

      if (response === undefined) return false;
      const body = response.body;

      if (body !== null) {
        const closed = yield* Effect.exit(
          Effect.tryPromise({
            try: () => body.cancel(),
            catch: (cause) =>
              new AgentInvocationError('network', 'Readiness body cleanup failed.', { cause }),
          }).pipe(
            Effect.interruptible,
            Effect.timeoutOption(1_000),
            Effect.flatMap((result) =>
              Option.isSome(result)
                ? Effect.void
                : Effect.fail(
                    new AgentInvocationError('network', 'Readiness body cleanup timed out.'),
                  ),
            ),
          ),
        );

        wait.cleanupExits.push(closed);

        if (Exit.isFailure(closed))
          return yield* Effect.fail(new ProcessCleanupError(wait.cleanupExits));
      }

      return response.status >= 200 && response.status < 300;
    }),
  );

/** Watches bounded stderr and detaches its listener when the observation ends. */
const stderrReady = (source: string, process: ManagedChild, wait: ReadinessWait) =>
  Effect.gen(function* () {
    const pattern = yield* Effect.try({
      try: () => new RegExp(source, 'u'),
      catch: (cause) =>
        new AgentInvocationError('invalid_envelope', 'Background readiness regex is invalid.', {
          cause,
        }),
    });

    let retained = process.stderrExcerpt() ?? '';

    if (pattern.test(retained)) return;
    const observed = yield* Deferred.make<void>();

    const data = (chunk: Buffer): void => {
      retained = `${retained}${chunk.toString('utf8')}`.slice(-READINESS_BUFFER_CHARACTERS);

      if (pattern.test(retained)) Deferred.doneUnsafe(observed, Effect.void);
    };

    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        process.stderr.on('data', data);
        // Output may arrive between the initial excerpt check and listener acquisition.
        retained = process.stderrExcerpt() ?? retained;

        if (pattern.test(retained)) Deferred.doneUnsafe(observed, Effect.void);
      }),
      () => Deferred.await(observed),
      () =>
        releaseObservation(
          wait,
          Effect.sync(() => process.stderr.off('data', data)),
        ),
    );
  });

/** Races only readiness observations; the caller still owns mandatory child cleanup. */
const waitForReadiness = Effect.fn('background.waitForReadiness')(function* (
  readiness: Readiness,
  wait: ReadinessWait,
) {
  const aborted = Effect.gen(function* () {
    const observed = yield* Deferred.make<never, AgentInvocationError>();

    const abort = (): void => {
      Deferred.doneUnsafe(observed, Effect.fail(wait.abortError()));
    };

    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        wait.signal.addEventListener('abort', abort, { once: true });

        if (wait.signal.aborted) abort();
      }),
      () => Deferred.await(observed),
      () =>
        releaseObservation(
          wait,
          Effect.sync(() => wait.signal.removeEventListener('abort', abort)),
        ),
    );
  });

  const exited = Deferred.await(wait.process.exit).pipe(
    Effect.flatMap(({ code, signal }) =>
      Effect.fail(
        new AgentInvocationError(
          'nonzero_exit',
          `Background agent exited before readiness (code ${String(code)}, signal ${String(signal)}).`,
        ),
      ),
    ),
  );

  const observe =
    readiness.kind === 'stderr'
      ? stderrReady(readiness.pattern, wait.process, wait)
      : Effect.gen(function* () {
          const endpoint = readiness.kind === 'http' ? assertLoopbackUrl(readiness.url) : undefined;

          for (;;) {
            const ready =
              readiness.kind === 'tcp'
                ? yield* tcpReady(readiness.host, readiness.port, wait)
                : yield* httpReady(endpoint!, wait);

            if (ready) return;
            yield* Effect.sleep(READINESS_INTERVAL_MS);
          }
        });

  yield* Effect.raceFirst(observe, Effect.raceFirst(aborted, exited));

  if (wait.cleanupExits.some((exit) => Exit.isFailure(exit)))
    return yield* Effect.fail(new ProcessCleanupError(wait.cleanupExits));
});

export { waitForReadiness };
