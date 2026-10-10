import type { CaseExecution } from '@attest/runtime';
import { resolve } from 'node:path';

import type { AgentRequest, AgentResource } from '@attest/contracts';
import {
  AgentInvocationError,
  invokeAgent,
  invokeMappedHttpAgent,
  invokeStreamingAgent,
  invokeVercelSandboxAgent,
  startBackgroundAgent,
  startJsonlBridgeAgent,
  startWebSocketAgent,
  type InvocationResult,
} from '@attest/executor';

import type { ResolvedNativeAgent } from './types.js';

const DEFAULT_OUTPUT_CAP_BYTES = 10 * 1024 * 1024;

/** Extra sandbox lifetime beyond every attempt, covering boot and artifact collection. */
const SANDBOX_OVERHEAD_MS = 60_000;

type AgentSession = {
  close(): Promise<void>;
  invoke(request: AgentRequest, signal?: AbortSignal): Promise<InvocationResult>;
};

type SessionAgent = Extract<
  ResolvedNativeAgent,
  { kind: 'background' | 'jsonl_bridge' | 'websocket' }
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
const startAgentRuntime = async (
  resolved: ResolvedNativeAgent,
  signal?: AbortSignal,
): Promise<AgentRuntime> => {
  switch (resolved.kind) {
    case 'background':
      return {
        kind: 'session',
        resolved,
        session: await startBackgroundAgent(resolved.agent, {
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
        session: await startJsonlBridgeAgent(resolved.agent, {
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
        session: await startWebSocketAgent(resolved.agent, {
          headers: resolved.headers,
          secrets: resolved.secrets,
          signal,
        }),
      };
    default:
      return { kind: 'direct', resolved };
  }
};

/**
 * Sends one request through the transport the agent resolved to. The connection probe and the
 * eval runner share this so both enforce the same caps, retries, and sandbox bounds.
 */
const invokeResolvedAgent = async (
  runtime: AgentRuntime,
  request: AgentRequest,
  options: InvokeResolvedAgentOptions,
): Promise<InvocationResult> => {
  if (runtime.kind === 'session') return runtime.session.invoke(request, options.signal);
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

      return invokeSandbox(resolved.sandbox, invocation, request, execution);
    }

    case 'stream':
      return invokeStreamingAgent(resolved.agent, request, {
        headers: resolved.headers,
        query: resolved.query,
        secrets: resolved.secrets,
        signal: options.signal,
      });
    case 'mapped_http':
      return invokeMappedHttpAgent(resolved.agent, request, {
        headers: resolved.headers,
        query: resolved.query,
        secrets: resolved.secrets,
        signal: options.signal,
      });
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
        invocation.preserveWorkingDirectory = true;
        invocation.workingDirectory = options.workerDirectory;
      }

      return invokeAgent(resolved.target, request, invocation);
    }
  }
};

/** Converts a startup throw into one failed attempt so the failure is recorded like any other. */
const startupFailure = (cause: unknown, durationMs: number): InvocationResult => {
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

  return { ...attempt, attempts: [attempt] };
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
