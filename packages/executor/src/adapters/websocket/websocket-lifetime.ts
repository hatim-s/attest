import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';

import { AgentInvocationError, type AgentInvocationErrorOptions } from '../../errors.js';
import type { InvocationResult } from '../../types.js';

/** Cleanup outcomes remain attached to the original Cause without changing its reasons. */
const WebSocketCleanup =
  Context.Service<readonly Cause.Cause<unknown>[]>('attest/WebSocketCleanup');

/** A completed case remains available when its socket release fails. */
class WebSocketCleanupError extends AgentInvocationError {
  readonly _tag = 'WebSocketCleanupError';

  constructor(
    readonly result: InvocationResult,
    readonly cleanupCause: Cause.Cause<unknown>,
    options?: AgentInvocationErrorOptions,
  ) {
    super(
      result.status === 'invocation_error' ? result.error.code : 'timeout',
      result.status === 'invocation_error'
        ? `${result.error.message} WebSocket close handshake could not be confirmed.`
        : 'WebSocket close handshake could not be confirmed.',
      {
        classification: 'close_timeout',
        applicationStarted: true,
        cause: { success: result, cleanup: cleanupCause },
        ...options,
      },
    );
  }

  protected override rebuild(options: AgentInvocationErrorOptions): WebSocketCleanupError {
    return new WebSocketCleanupError(this.result, this.cleanupCause, options);
  }
}

/** Bounds retry waiting by business cancellation without interrupting an evidence-producing attempt. */
const waitForWebSocketRetry = (delayMs: number, signal: AbortSignal): Effect.Effect<void> =>
  Effect.raceFirst(
    Effect.sleep(delayMs),
    Effect.callback<void>((resume) => {
      const aborted = (): void => resume(Effect.void);
      signal.addEventListener('abort', aborted, { once: true });

      if (signal.aborted) aborted();

      return Effect.sync(() => signal.removeEventListener('abort', aborted));
    }),
  );

/** Runs all release work, retaining primary defects/interruption and completed evidence. */
const withWebSocketRelease = <A, E, R, E2, R2>(
  primary: Effect.Effect<A, E, R>,
  release: Effect.Effect<unknown, E2, R2>,
  cleanupError: (value: A, cause: Cause.Cause<unknown>) => AgentInvocationError = (value, cause) =>
    new AgentInvocationError('network', 'WebSocket cleanup could not be confirmed.', {
      applicationStarted: true,
      cause: { success: value, cleanup: cause },
    }),
): Effect.Effect<A, E | AgentInvocationError, R | R2> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const completed = yield* Effect.exit(restore(primary));
      const cleanup = yield* Effect.exit(release);

      if (Exit.isFailure(completed)) {
        return yield* Effect.failCause(
          Exit.isFailure(cleanup)
            ? Cause.annotate(
                completed.cause,
                Context.make(WebSocketCleanup, [
                  ...(Context.getOrUndefined(
                    Cause.annotations(completed.cause),
                    WebSocketCleanup,
                  ) ?? []),
                  cleanup.cause,
                ]),
                { overwrite: true },
              )
            : completed.cause,
        );
      }

      if (Exit.isFailure(cleanup)) {
        return yield* Effect.fail(cleanupError(completed.value, cleanup.cause));
      }

      return completed.value;
    }),
  );

/** Copies an opening receipt onto an invocation-owned error without mutating shared settlement. */
const retainWebSocketOpeningCause = (
  error: AgentInvocationError,
  cause: Cause.Cause<AgentInvocationError>,
): AgentInvocationError =>
  new AgentInvocationError(error.code, error.message, {
    ...error,
    cause: error,
    effectCause: cause,
    applicationStarted:
      error.applicationStarted === true ||
      cause.reasons.some(
        (reason) => Cause.isFailReason(reason) && reason.error.applicationStarted === true,
      ),
  });

/** Keeps a late receipt on both the terminal result and its corresponding attempt. */
const retainWebSocketOpeningResult = (
  result: InvocationResult,
  cause: Cause.Cause<AgentInvocationError> | undefined,
): InvocationResult => {
  if (result.status !== 'invocation_error' || cause === undefined) return result;
  const error = retainWebSocketOpeningCause(result.error, cause);

  return {
    ...result,
    error,
    attempts: result.attempts.map((attempt, index) =>
      index === result.attempts.length - 1 && attempt.status === 'invocation_error'
        ? { ...attempt, error }
        : attempt,
    ),
  };
};

export {
  retainWebSocketOpeningCause,
  retainWebSocketOpeningResult,
  withWebSocketRelease,
  WebSocketCleanupError,
  waitForWebSocketRetry,
  WebSocketCleanup,
};
