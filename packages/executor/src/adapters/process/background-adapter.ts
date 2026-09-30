import type { AgentRequest, AgentResource } from '@attest/contracts';

import { AgentInvocationError, abortedError } from '../../errors.js';
import { DEFAULT_REQUEST_BYTES, DEFAULT_STDERR_BYTES } from '../../internal/agent-defaults.js';
import type { InvocationResult } from '../../types.js';
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
  private closed = false;
  private closePromise?: Promise<void>;
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
    options.signal?.addEventListener('abort', () => this.runController.abort(), { once: true });
  }

  /** Starts argv directly and blocks until the configured readiness contract succeeds. */
  static async start(
    agent: BackgroundAgentResource,
    options: BackgroundSessionOptions,
  ): Promise<BackgroundAgentSession> {
    assertLoopbackUrl(agent.transport.invoke.url);
    if (agent.transport.shutdown !== undefined) assertLoopbackUrl(agent.transport.shutdown.url);
    if (agent.transport.readiness.kind === 'http') assertLoopbackUrl(agent.transport.readiness.url);
    if (agent.transport.readiness.kind === 'tcp' && !loopbackHost(agent.transport.readiness.host)) {
      throw new AgentInvocationError(
        'network',
        'Background TCP readiness requires a loopback host.',
      );
    }
    const process = await ManagedChild.start({
      argv: agent.transport.start_argv,
      cwd: options.cwd,
      env: options.env,
      stderrCapBytes: Math.min(
        agent.limits?.total_evidence_bytes ?? DEFAULT_STDERR_BYTES,
        DEFAULT_STDERR_BYTES,
      ),
    });
    const session = new BackgroundAgentSession(agent, process, options);
    try {
      await session.waitForReadiness();
      return session;
    } catch (error: unknown) {
      const diagnostics = session.startupDiagnostics();
      await session.close();
      if (error instanceof AgentInvocationError) error.diagnostics = diagnostics;
      throw error;
    }
  }

  /** Captures only bounded startup evidence for stable CLI error normalization. */
  private startupDiagnostics(): { exitCode?: number; stderrExcerpt?: string } {
    const stderr = this.process.stderrExcerpt();
    return {
      ...(this.process.exitCode === null ? {} : { exitCode: this.process.exitCode }),
      ...(stderr === undefined
        ? {}
        : { stderrExcerpt: redactTransportText(stderr, this.options.secrets ?? []) }),
    };
  }

  private waitForReadiness(): Promise<void> {
    return waitForReadiness(this.agent.transport.readiness, {
      process: this.process,
      signal: AbortSignal.any([
        this.runController.signal,
        AbortSignal.timeout(this.agent.timeouts?.connect_ms ?? DEFAULT_STARTUP_MS),
      ]),
      abortError: () => abortedError(this.options.signal, 'Background agent startup'),
    });
  }

  /** Invokes the ready service through the existing mapped HTTP retry and evidence boundary. */
  async invoke(request: AgentRequest, signal?: AbortSignal): Promise<InvocationResult> {
    if (this.closed) {
      throw new AgentInvocationError('network', 'Background agent session is closed.');
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
    const result = await invokeMappedHttpAgent(mapped, request, {
      headers: this.options.invokeHeaders,
      query: this.options.invokeQuery,
      secrets: this.options.secrets,
      signal,
      deadlineSignal: this.runController.signal,
    });
    const stderr = this.process.stderrExcerpt();
    const diagnostics = {
      ...result.diagnostics,
      ...(stderr === undefined
        ? {}
        : { stderrExcerpt: redactTransportText(stderr, this.options.secrets ?? []) }),
      ...(this.process.exitCode === null ? {} : { exitCode: this.process.exitCode }),
    };
    return {
      ...result,
      diagnostics,
      attempts: result.attempts.map((attempt) => ({
        ...attempt,
        diagnostics: { ...attempt.diagnostics, ...diagnostics },
      })),
    };
  }

  private async requestShutdown(): Promise<void> {
    const shutdown = this.agent.transport.shutdown;
    if (shutdown === undefined || this.process.exitCode !== null) return;
    const materialized = materializeStaticRequest(
      resolveRequestTemplate(shutdown, {
        headers: this.options.shutdownHeaders,
        query: this.options.shutdownQuery,
      }),
      this.agent.limits?.request_bytes ?? DEFAULT_REQUEST_BYTES,
    );
    const signal = AbortSignal.timeout(this.agent.transport.stop_timeout_ms);
    try {
      const response = await fetch(materialized.url, {
        method: materialized.method,
        headers: materialized.headers,
        body: materialized.body,
        redirect: 'manual',
        signal,
      });
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // Graceful shutdown is best effort; mandatory process-tree cleanup follows.
    }
  }

  /** Attempts authored shutdown, then always enforces TERM/grace/KILL cleanup. */
  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    if (this.runTimer !== undefined) clearTimeout(this.runTimer);
    this.closePromise = (async () => {
      await this.process.snapshotDescendants();
      await this.requestShutdown();
      await this.process.terminate(this.agent.transport.stop_timeout_ms);
    })();
    return this.closePromise;
  }
}

const startBackgroundAgent = (
  agent: BackgroundAgentResource,
  options: BackgroundSessionOptions,
): Promise<BackgroundAgentSession> => BackgroundAgentSession.start(agent, options);

export {
  BackgroundAgentSession,
  startBackgroundAgent,
  type BackgroundAgentResource,
  type BackgroundSessionOptions,
};
