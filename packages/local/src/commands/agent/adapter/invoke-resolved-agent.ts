import { isSandboxAttemptCleanupError, startWebSocketAgent } from '@attest/executor';
import type { CaseExecution } from '@attest/runtime';
import * as Effect from 'effect/Effect';
import type * as Cause from 'effect/Cause';
import { recoverOrdinary } from './lifecycle-cause.js';
import type * as Scope from 'effect/Scope';
import { resolve } from 'node:path';

import type { AgentRequest, AgentResource } from '@attest/contracts';
import {
  getInvocationPriorAttempts,
  AgentInvocationError,
  CliCleanupError,
  ProcessCleanupError,
  CallbackCleanupError,
  StreamCleanupError,
  WebSocketCleanupError,
  enforceArtifactLimits,
  invokeAgent,
  invokeMappedHttpAgent,
  invokeStreamingAgent,
  invokeVercelSandboxAgent,
  startBackgroundAgent,
  startJsonlBridgeAgent,
  type InvocationResult,
} from '@attest/executor';

import type { ResolvedNativeAgent } from './types.js';
import { startCallbackSession } from './callback-session.js';

const DEFAULT_OUTPUT_CAP_BYTES = 10 * 1024 * 1024;

/** Extra sandbox lifetime beyond every attempt, covering boot and artifact collection. */
const SANDBOX_OVERHEAD_MS = 60_000;

type AgentSession = {
  close(): Effect.Effect<void, Error>;
  invoke(request: AgentRequest, signal?: AbortSignal): Effect.Effect<InvocationResult, Error>;
};

type SessionAgent = Extract<
  ResolvedNativeAgent,
  { kind: 'background' | 'callback' | 'jsonl_bridge' | 'websocket' }
>;

/** A resolved agent ready to invoke: an open session, or a transport invoked per request. */
type AgentRuntime =
  | { kind: 'session'; resolved: SessionAgent; session: AgentSession }
  | { kind: 'direct'; resolved: Exclude<ResolvedNativeAgent, SessionAgent> };

type InvokeResolvedAgentOptions = {
  agent: AgentResource;
  /** Sandbox transport implementation supplied by the host or a lifecycle test. */
  invokeSandbox?: typeof invokeVercelSandboxAgent;
  attemptTimeoutMs: number;
  projectRoot: string;
  /** Last path segment under the sandbox artifact directory, such as the case index. */
  sandboxArtifactSegment: string;
  signal?: AbortSignal;
  /** Eval worker directory; the agent runs there and sandbox artifacts land there. */
  workerDirectory?: string;
};

/**
 * Opens the run-scoped session for transports that keep a process or connection alive between
 * requests; other transports are invoked fresh per request.
 */
const startAgentRuntime = Effect.fn('startAgentRuntime')(function* (
  resolved: ResolvedNativeAgent,
  signal?: AbortSignal,
): Effect.fn.Return<AgentRuntime, Error, Scope.Scope> {
  switch (resolved.kind) {
    case 'background':
      return {
        kind: 'session',
        resolved,
        session: yield* startBackgroundAgent(resolved.agent, {
          cwd: resolved.cwd,
          env: resolved.env,
          invokeHeaders: resolved.invokeHeaders,
          invokeQuery: resolved.invokeQuery,
          secrets: resolved.secrets,
          shutdownHeaders: resolved.shutdownHeaders,
          shutdownQuery: resolved.shutdownQuery,
          signal,
        }),
      };
    case 'jsonl_bridge':
      return {
        kind: 'session',
        resolved,
        session: yield* startJsonlBridgeAgent(resolved.agent, {
          cwd: resolved.cwd,
          env: resolved.env,
          secrets: resolved.secrets,
          signal,
        }),
      };
    case 'websocket':
      return {
        kind: 'session',
        resolved,
        session: yield* startWebSocketAgent(resolved.agent, {
          headers: resolved.headers,
          secrets: resolved.secrets,
          signal,
        }),
      };
    case 'callback':
      return { kind: 'session', resolved, session: yield* startCallbackSession(resolved) };

    default:
      return { kind: 'direct', resolved };
  }
});

/** Sends one request through the transport the agent resolved to. */
const dispatch = Effect.fn('dispatch')(function* (
  runtime: AgentRuntime,
  request: AgentRequest,
  options: InvokeResolvedAgentOptions,
): Effect.fn.Return<InvocationResult, Error> {
  if (runtime.kind === 'session') return yield* runtime.session.invoke(request, options.signal);
  const { resolved } = runtime;
  const responseBytes = options.agent.limits?.response_bytes ?? DEFAULT_OUTPUT_CAP_BYTES;
  const retries = options.agent.retry?.retries ?? 0;

  switch (resolved.kind) {
    case 'vercel_sandbox': {
      const artifactDirectory = resolved.sandbox.artifact_directory;

      const artifactRoot =
        options.workerDirectory ??
        (artifactDirectory === undefined
          ? undefined
          : resolve(
              options.projectRoot,
              artifactDirectory,
              request.run_id,
              options.sandboxArtifactSegment,
            ));

      const invokeSandbox = options.invokeSandbox ?? invokeVercelSandboxAgent;

      const invocation: Parameters<typeof invokeSandbox>[1] = {
        argv: resolved.argv,
        env: resolved.env,
        attemptTimeoutMs: options.attemptTimeoutMs,
        retries,
        responseBytes,
        sandboxTimeoutMs: Math.min(
          Number.MAX_SAFE_INTEGER,
          options.attemptTimeoutMs * (retries + 1) + SANDBOX_OVERHEAD_MS,
        ),
      };

      if (resolved.cwd !== undefined) invocation.cwd = resolved.cwd;
      const execution: Parameters<typeof invokeSandbox>[3] = { projectRoot: options.projectRoot };

      if (artifactRoot !== undefined) execution.artifactRoot = artifactRoot;

      if (options.signal !== undefined) execution.signal = options.signal;

      return yield* invokeSandbox(resolved.sandbox, invocation, request, execution);
    }

    case 'stream': {
      return yield* invokeStreamingAgent(resolved.agent, request, {
        headers: resolved.headers,
        query: resolved.query,
        secrets: resolved.secrets,
        signal: options.signal,
      });
    }

    case 'mapped_http': {
      return yield* invokeMappedHttpAgent(resolved.agent, request, {
        headers: resolved.headers,
        query: resolved.query,
        secrets: resolved.secrets,
        signal: options.signal,
      });
    }

    case 'direct': {
      const invocation: Parameters<typeof invokeAgent>[2] = {
        env: resolved.env,
        httpHeaders: resolved.headers,
        outputCapBytes: responseBytes,
        retries,
        signal: options.signal,
        timeoutMs: options.attemptTimeoutMs,
      };

      if (options.workerDirectory !== undefined) {
        invocation.workingDirectory = options.workerDirectory;
      }

      return yield* recoverOrdinary(
        invokeAgent(resolved.target, request, invocation),
        (cause, fullCause) =>
          cause instanceof CliCleanupError && cause.attempt !== undefined
            ? Effect.succeed(startupFailure(cause, cause.attempt.durationMs, fullCause))
            : Effect.failCause(fullCause),
      );
    }
  }
});

/**
 * Sends one request and applies the artifact caps to whatever came back. The connection probe and
 * the eval runner share this so both enforce the same caps, retries, and sandbox bounds; it is the
 * one place every transport's parsed response passes through.
 */
const invokeResolvedAgent = (
  runtime: AgentRuntime,
  request: AgentRequest,
  options: InvokeResolvedAgentOptions,
): Effect.Effect<InvocationResult, Error> =>
  Effect.map(
    recoverOrdinary(dispatch(runtime, request, options), (cause, fullCause) =>
      cause instanceof CallbackCleanupError ||
      cause instanceof StreamCleanupError ||
      cause instanceof WebSocketCleanupError
        ? Effect.succeed(startupFailure(cause, cause.result.durationMs))
        : Effect.failCause(fullCause),
    ),
    (result) => enforceArtifactLimits(result, options.agent.limits),
  );

/** Projects operational startup or completed-attempt cleanup failures into recordable evidence. */
const startupFailure = (
  cause: unknown,
  durationMs: number,
  fullCause?: Cause.Cause<Error>,
): InvocationResult => {
  const prior = fullCause === undefined ? [] : getInvocationPriorAttempts(fullCause);

  if (isSandboxAttemptCleanupError(cause)) {
    const completed = cause.attempt;

    const attempt = {
      status: 'invocation_error' as const,
      error: new AgentInvocationError(
        completed.status === 'invocation_error' ? completed.error.code : 'network',
        'Vercel sandbox cleanup was not confirmed.',
        { cause, applicationStarted: true },
      ),
      diagnostics: { ...completed.diagnostics, sandboxCleanupConfirmed: false },
      durationMs: completed.durationMs,
      rawExcerpt: completed.rawExcerpt,
      warnings: completed.warnings,
    };

    return { ...attempt, attempts: [...prior, attempt] };
  }

  if (cause instanceof ProcessCleanupError && cause.completed !== undefined) {
    const completed = cause.completed;

    const error = new AgentInvocationError(
      completed.status === 'invocation_error' ? completed.error.code : cause.code,
      completed.status === 'invocation_error' ? completed.error.message : cause.message,
      { cause, applicationStarted: true },
    );

    const failed = {
      status: 'invocation_error' as const,
      error,
      diagnostics: completed.diagnostics,
      durationMs: completed.durationMs,
      rawExcerpt: completed.rawExcerpt,
      warnings: completed.warnings,
    };

    return { ...failed, attempts: [...completed.attempts.slice(0, -1), failed] };
  }

  if (
    cause instanceof CallbackCleanupError ||
    cause instanceof StreamCleanupError ||
    cause instanceof WebSocketCleanupError
  ) {
    const completed = cause.result;
    const primary = completed.status === 'invocation_error' ? completed.error : undefined;

    const message =
      cause instanceof CallbackCleanupError
        ? 'Callback cleanup could not be confirmed.'
        : 'Streaming cleanup could not be confirmed.';

    const attempt = {
      status: 'invocation_error' as const,
      error:
        cause instanceof WebSocketCleanupError
          ? cause
          : new AgentInvocationError(
              primary?.code ?? 'network',
              primary === undefined ? message : `${primary.message} ${message}`,
              { cause, applicationStarted: true },
            ),
      diagnostics: completed.diagnostics,
      durationMs: completed.durationMs,
      rawExcerpt: completed.rawExcerpt,
      warnings: completed.warnings,
    };

    return { ...attempt, attempts: [...completed.attempts.slice(0, -1), attempt] };
  }

  if (cause instanceof CliCleanupError && cause.attempt !== undefined) {
    const completed = cause.attempt;
    const primary = completed.status === 'invocation_error' ? completed.error : undefined;
    const message = 'CLI cleanup could not be confirmed.';

    const attempt = {
      status: 'invocation_error' as const,
      error: new AgentInvocationError(
        primary?.code ?? 'network',
        primary === undefined ? message : `${primary.message} ${message}`,
        { cause, applicationStarted: true },
      ),
      diagnostics: completed.diagnostics,
      durationMs: completed.durationMs,
      rawExcerpt: completed.rawExcerpt,
      warnings: completed.warnings,
    };

    return { ...attempt, attempts: [...prior, attempt] };
  }

  const invocationError =
    cause instanceof AgentInvocationError
      ? cause
      : new AgentInvocationError('network', 'Agent runtime initialization failed.', {
          cause: cause,
        });

  const diagnostics = invocationError.diagnostics ?? {};

  const attempt = {
    status: 'invocation_error' as const,
    error: invocationError,
    diagnostics,
    durationMs,
    warnings: [],
  };

  return { ...attempt, attempts: [...prior, attempt] };
};

/** Maps a failed invocation to the case outcome recorded for it. */
const invocationOutcome = (
  result: Extract<InvocationResult, { status: 'invocation_error' }>,
): Exclude<CaseExecution['outcome'], 'completed'> => {
  if (result.error.code === 'timeout' || result.error.code === 'cancelled') {
    return result.error.code;
  }

  return 'invocation_error';
};

export {
  invocationOutcome,
  invokeResolvedAgent,
  startAgentRuntime,
  startupFailure,
  type AgentRuntime,
};
