import type { AgentRequest, AgentResource } from '@attest/contracts';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Deferred from 'effect/Deferred';
import * as Option from 'effect/Option';
import { ProcessCleanupDiagnostics, ProcessCleanupError } from './process-cleanup.js';

import { AgentInvocationError, abortedError } from '../../errors.js';
import { DEFAULT_REQUEST_BYTES, DEFAULT_STDERR_BYTES } from '../../internal/agent-defaults.js';
import type { InvocationDiagnostics, InvocationResult } from '../../types.js';
import { invokeMappedHttpAgent, type HttpAgentResource } from '../http/mapped-http-adapter.js';
import { materializeStaticRequest, resolveRequestTemplate } from '../http/request-template.js';
import { redactTransportText } from '../http/redaction.js';
import { waitForReadiness } from './background-readiness.js';
import { assertLoopbackUrl, loopbackHost } from './loopback-url.js';
import { ManagedChild } from './managed-child.js';

type BackgroundAgentResource = AgentResource & {
  transport: Extract<AgentResource['transport'], { kind: 'background_cli' }>;
};

type BackgroundSessionOptions = {
  cwd: string;
  env: Record<string, string>;
  invokeHeaders?: Record<string, string>;
  invokeQuery?: Record<string, string>;
  shutdownHeaders?: Record<string, string>;
  shutdownQuery?: Record<string, string>;
  secrets?: readonly string[];
  signal?: AbortSignal;
};

const DEFAULT_STARTUP_MS = 10_000;

/** Owns one background service from readiness through graceful shutdown and tree cleanup. */
class BackgroundAgentSession {
  private readonly active = new Set<Deferred.Deferred<void>>();
  private completed?: InvocationResult;
  private readonly readinessCleanupExits: Exit.Exit<unknown, unknown>[] = [];
  readonly cleanupExits: Exit.Exit<unknown, unknown>[] = [];

  private readonly cleanup = Deferred.makeUnsafe<void, AgentInvocationError>();
  private cleanupStarted = false;
  private readonly callerAbort = (): void => this.runController.abort();
  private readonly runController = new AbortController();
  private runTimer?: NodeJS.Timeout;

  private constructor(
    readonly agent: BackgroundAgentResource,
    private readonly process: ManagedChild,
    private readonly options: BackgroundSessionOptions,
  ) {
    if (agent.timeouts?.run_ms !== undefined) {
      this.runTimer = setTimeout(() => this.runController.abort(), agent.timeouts.run_ms);
    }

    options.signal?.addEventListener('abort', this.callerAbort, { once: true });

    if (options.signal?.aborted) this.callerAbort();
  }

  /** Starts argv directly and blocks until the configured readiness contract succeeds. */
  static start = Effect.fn('BackgroundAgentSession.start')(function* (
    agent: BackgroundAgentResource,
    options: BackgroundSessionOptions,
  ) {
    yield* Effect.try({
      try: () => {
        if (options.signal?.aborted === true)
          throw new AgentInvocationError('cancelled', 'Background agent run was cancelled.');
        assertLoopbackUrl(agent.transport.invoke.url);

        if (agent.transport.shutdown !== undefined) assertLoopbackUrl(agent.transport.shutdown.url);

        if (agent.transport.readiness.kind === 'http')
          assertLoopbackUrl(agent.transport.readiness.url);

        if (
          agent.transport.readiness.kind === 'tcp' &&
          !loopbackHost(agent.transport.readiness.host)
        )
          throw new AgentInvocationError(
            'network',
            'Background TCP readiness requires a loopback host.',
          );
      },
      catch: (error) =>
        error instanceof AgentInvocationError
          ? error
          : new AgentInvocationError('network', 'Invalid background endpoint.', { cause: error }),
    });

    const process = yield* ManagedChild.start({
      argv: agent.transport.start_argv,
      cwd: options.cwd,
      env: options.env,
      stderrCapBytes: Math.min(
        agent.limits?.total_evidence_bytes ?? DEFAULT_STDERR_BYTES,
        DEFAULT_STDERR_BYTES,
      ),
    });

    const session = new BackgroundAgentSession(agent, process, options);
    yield* Effect.addFinalizer(() => Effect.asVoid(Effect.exit(session.close())));

    const primary = yield* Effect.exit(
      Effect.interruptible(session.waitForReadiness()).pipe(
        Effect.mapError((error) => {
          Object.defineProperty(error, 'diagnostics', {
            value: session.startupDiagnostics(),
            configurable: true,
          });

          return error;
        }),
      ),
    );

    if (Exit.isFailure(primary)) {
      const cleanup = yield* Effect.exit(session.close());

      if (Exit.isFailure(cleanup)) {
        for (const reason of primary.cause.reasons) {
          if (Cause.isFailReason(reason))
            reason.error.cause = {
              primary: reason.error.cause,
              cleanupFailure: Cause.squash(cleanup.cause),
            };
        }
      }

      const cause = Exit.isFailure(cleanup)
        ? Cause.annotate(primary.cause, Context.make(ProcessCleanupDiagnostics, cleanup.cause))
        : primary.cause;

      // Preserve the original runtime Cause, including defects and interruption.
      return yield* Effect.failCause(cause);
    }

    return session;
  }, Effect.uninterruptible);

  /** Captures only bounded startup evidence for stable CLI error normalization. */
  private startupDiagnostics(): InvocationDiagnostics {
    const stderr = this.process.stderrExcerpt();

    const diagnostics: InvocationDiagnostics = {};

    if (this.process.exitCode !== null) diagnostics.exitCode = this.process.exitCode;

    if (stderr !== undefined)
      diagnostics.stderrExcerpt = redactTransportText(stderr, this.options.secrets ?? []);

    return diagnostics;
  }

  private waitForReadiness() {
    return waitForReadiness(this.agent.transport.readiness, {
      process: this.process,
      cleanupExits: this.readinessCleanupExits,
      signal: AbortSignal.any([
        this.runController.signal,
        AbortSignal.timeout(this.agent.timeouts?.connect_ms ?? DEFAULT_STARTUP_MS),
      ]),
      abortError: () => abortedError(this.options.signal, 'Background agent startup'),
    });
  }

  /** Invokes the ready service through the existing mapped HTTP retry and evidence boundary. */
  private invokeNow = Effect.fn('BackgroundAgentSession.invoke')(function* (
    this: BackgroundAgentSession,
    request: AgentRequest,
    signal?: AbortSignal,
  ) {
    if (this.closed) {
      return yield* Effect.fail(
        new AgentInvocationError('network', 'Background agent session is closed.'),
      );
    }

    const mapped: HttpAgentResource = {
      ...this.agent,
      transport: {
        kind: 'http',
        lifecycle: 'external',
        response_mode: 'mapped',
        request: this.agent.transport.invoke,
        extraction: this.agent.transport.extraction,
      },
    };

    // Session cancellation and the run deadline both end the service run, so they are timeouts.
    const result = yield* invokeMappedHttpAgent(mapped, request, {
      headers: this.options.invokeHeaders,
      query: this.options.invokeQuery,
      secrets: this.options.secrets,
      signal,
      deadlineSignal: this.runController.signal,
    });

    const stderr = this.process.stderrExcerpt();

    const diagnostics = { ...result.diagnostics };

    if (stderr !== undefined)
      diagnostics.stderrExcerpt = redactTransportText(stderr, this.options.secrets ?? []);

    if (this.process.exitCode !== null) diagnostics.exitCode = this.process.exitCode;

    const completed: InvocationResult = {
      ...result,
      diagnostics,
      attempts: result.attempts.map((attempt) => ({
        ...attempt,
        diagnostics: { ...attempt.diagnostics, ...diagnostics },
      })),
    };

    this.completed = completed;

    return completed;
  });

  /** Joins every admitted evidence owner before process release. */
  invoke(request: AgentRequest, signal?: AbortSignal) {
    return Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const done = Deferred.makeUnsafe<void>();
        this.active.add(done);

        return restore(this.invokeNow(request, signal)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              this.active.delete(done);
              Deferred.doneUnsafe(done, Effect.void);
            }),
          ),
        );
      }),
    );
  }

  private requestShutdown = Effect.fn('background.requestShutdown')(function* (
    this: BackgroundAgentSession,
  ) {
    const shutdown = this.agent.transport.shutdown;

    if (shutdown === undefined || this.process.exitCode !== null) return;

    const materialized = materializeStaticRequest(
      resolveRequestTemplate(shutdown, {
        headers: this.options.shutdownHeaders,
        query: this.options.shutdownQuery,
      }),
      this.agent.limits?.request_bytes ?? DEFAULT_REQUEST_BYTES,
    );

    const response = yield* Effect.exit(
      Effect.tryPromise({
        try: (signal) =>
          fetch(materialized.url, {
            method: materialized.method,
            headers: materialized.headers,
            body: materialized.body,
            redirect: 'manual',
            signal,
          }),
        catch: (cause) =>
          new AgentInvocationError('network', 'Background shutdown request failed.', { cause }),
      }).pipe(
        Effect.interruptible,
        Effect.timeoutOption(this.agent.transport.stop_timeout_ms),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : Effect.fail(
                new AgentInvocationError('network', 'Background shutdown request timed out.'),
              ),
        ),
      ),
    );

    // Authored shutdown is best effort. Its Exit is retained beside mandatory tree cleanup.
    this.cleanupExits.push(response);

    if (Exit.isSuccess(response) && response.value.body !== null) {
      const bodyExit = yield* Effect.exit(
        Effect.tryPromise({
          try: () => response.value.body!.cancel(),
          catch: (cause) =>
            new AgentInvocationError('network', 'Background shutdown body cleanup failed.', {
              cause,
            }),
        }).pipe(
          Effect.interruptible,
          Effect.timeoutOption(1_000),
          Effect.flatMap((result) =>
            Option.isSome(result)
              ? Effect.void
              : Effect.fail(
                  new AgentInvocationError(
                    'network',
                    'Background shutdown body cleanup timed out.',
                  ),
                ),
          ),
        ),
      );

      this.cleanupExits.push(bodyExit);

      if (Exit.isFailure(bodyExit))
        return yield* Effect.fail(new ProcessCleanupError(this.cleanupExits, this.completed));
    }
  });

  private closed = false;

  /** Captures every release step even if an earlier step fails. */
  private release = Effect.fn('BackgroundAgentSession.release')(function* (
    this: BackgroundAgentSession,
  ) {
    this.closed = true;
    this.runController.abort();
    yield* Effect.all([...this.active].map((done) => Deferred.await(done)));

    const detached = yield* Effect.exit(
      Effect.sync(() => {
        if (this.runTimer !== undefined) clearTimeout(this.runTimer);
        this.options.signal?.removeEventListener('abort', this.callerAbort);
      }),
    );

    const snapshot = yield* Effect.exit(this.process.snapshotDescendants());
    const shutdown = yield* Effect.exit(this.requestShutdown());

    const terminated = yield* Effect.exit(
      this.process.terminate(this.agent.transport.stop_timeout_ms),
    );

    this.cleanupExits.push(...this.readinessCleanupExits, detached, snapshot, shutdown, terminated);

    if (
      [...this.readinessCleanupExits, detached, snapshot, shutdown, terminated].some((exit) =>
        Exit.isFailure(exit),
      )
    )
      return yield* Effect.fail(new ProcessCleanupError(this.cleanupExits, this.completed));
  }, Effect.uninterruptible);

  /** Reuses the recorded cleanup Exit; a failed close never permits reuse or another sweep. */
  close(): Effect.Effect<void, AgentInvocationError> {
    return Effect.uninterruptible(
      Effect.gen(
        function* (this: BackgroundAgentSession) {
          if (!this.cleanupStarted) {
            this.cleanupStarted = true;
            const exit = yield* Effect.exit(this.release());
            Deferred.doneUnsafe(this.cleanup, exit);
          }

          yield* Deferred.await(this.cleanup);
        }.bind(this),
      ),
    );
  }
}

/** Opens a process session in the caller's scope, which must outlive every invocation. */
const startBackgroundAgent = BackgroundAgentSession.start;

export {
  BackgroundAgentSession,
  startBackgroundAgent,
  type BackgroundAgentResource,
  type BackgroundSessionOptions,
};
