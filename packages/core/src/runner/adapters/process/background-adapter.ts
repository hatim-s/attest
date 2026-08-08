import { connect } from 'node:net';
import { isIP } from 'node:net';

import { AGENT_PROTOCOL, type AgentRequest, type AgentResource } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import type { InvocationResult } from '../../types.js';
import {
  invokeMappedHttpAgent,
  type HttpAgentResource,
  type MappedHttpInvokeOptions,
} from '../http/mapped-http-adapter.js';
import {
  materializeHttpRequest,
  type ResolvedHttpRequestTemplate,
} from '../http/request-template.js';
import { redactTransportText } from '../http/redaction.js';
import { ManagedChild } from './managed-child.js';

type BackgroundAgentResource = AgentResource & {
  transport: Extract<AgentResource['transport'], { kind: 'background_cli' }>;
};

type BackgroundSessionOptions = {
  cwd: string;
  env: Record<string, string>;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  secrets?: readonly string[];
  signal?: AbortSignal;
};

const DEFAULT_STARTUP_MS = 10_000;
const DEFAULT_STDERR_BYTES = 16 * 1024;
const READINESS_INTERVAL_MS = 50;
const READINESS_BUFFER_CHARACTERS = 16 * 1024;

const loopbackHost = (hostname: string): boolean => {
  if (hostname === 'localhost') return true;
  if (isIP(hostname) === 4) return hostname.startsWith('127.');
  return hostname === '::1' || hostname === '[::1]';
};

/** Prevents a managed local process definition from becoming a general network pivot. */
const assertLoopbackUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new AgentInvocationError('network', 'Background agent URL is invalid.', { cause: error });
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !loopbackHost(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new AgentInvocationError(
      'network',
      'Background agents require credential-free loopback HTTP endpoints.',
    );
  }
  return url;
};

const wait = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new AgentInvocationError('timeout', 'Background agent readiness timed out.'));
    };
    function finish(): void {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });

const tcpReady = (host: string, port: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (!loopbackHost(host) || signal.aborted) {
      resolve(false);
      return;
    }
    const socket = connect({ host, port });
    const finish = (ready: boolean): void => {
      signal.removeEventListener('abort', abort);
      socket.destroy();
      resolve(ready);
    };
    const abort = (): void => finish(false);
    signal.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

const httpReady = async (url: string, signal: AbortSignal): Promise<boolean> => {
  const endpoint = assertLoopbackUrl(url);
  try {
    const response = await fetch(endpoint, { redirect: 'manual', signal });
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
};

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
      await session.close();
      throw error;
    }
  }

  private async waitForReadiness(): Promise<void> {
    const startupSignal = AbortSignal.any([
      this.runController.signal,
      AbortSignal.timeout(this.agent.timeouts?.connect_ms ?? DEFAULT_STARTUP_MS),
    ]);
    const readiness = this.agent.transport.readiness;
    if (readiness.kind === 'stderr') {
      let pattern: RegExp;
      try {
        pattern = new RegExp(readiness.pattern, 'u');
      } catch (error: unknown) {
        throw new AgentInvocationError(
          'invalid_envelope',
          'Background readiness regex is invalid.',
          { cause: error },
        );
      }
      let retained = this.process.stderrExcerpt() ?? '';
      if (pattern.test(retained)) return;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const abort = (): void =>
          finish(() =>
            reject(new AgentInvocationError('timeout', 'Background agent startup timed out.')),
          );
        const data = (chunk: Buffer): void => {
          retained = `${retained}${chunk.toString('utf8')}`.slice(-READINESS_BUFFER_CHARACTERS);
          if (pattern.test(retained)) finish(resolve);
        };
        const finish = (operation: () => void): void => {
          if (settled) return;
          settled = true;
          startupSignal.removeEventListener('abort', abort);
          this.process.child.stderr.off('data', data);
          operation();
        };
        startupSignal.addEventListener('abort', abort, { once: true });
        this.process.child.stderr.on('data', data);
        if (startupSignal.aborted) abort();
      });
      return;
    }

    for (;;) {
      if (startupSignal.aborted) {
        throw new AgentInvocationError(
          this.options.signal?.aborted === true ? 'cancelled' : 'timeout',
          this.options.signal?.aborted === true
            ? 'Background agent startup was cancelled.'
            : 'Background agent startup timed out.',
        );
      }
      if (this.process.child.exitCode !== null || this.process.child.signalCode !== null) {
        throw new AgentInvocationError(
          'nonzero_exit',
          'Background agent exited before becoming ready.',
        );
      }
      const ready =
        readiness.kind === 'http'
          ? await httpReady(readiness.url, startupSignal)
          : await tcpReady(readiness.host, readiness.port, startupSignal);
      if (ready) return;
      await wait(READINESS_INTERVAL_MS, startupSignal);
    }
  }

  /** Invokes the ready service through the existing mapped HTTP retry and evidence boundary. */
  async invoke(request: AgentRequest, signal?: AbortSignal): Promise<InvocationResult> {
    if (this.closed) {
      throw new AgentInvocationError('network', 'Background agent session is closed.');
    }
    const combined =
      signal === undefined
        ? this.runController.signal
        : AbortSignal.any([signal, this.runController.signal]);
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
    let result = await invokeMappedHttpAgent(mapped, request, {
      headers: this.options.headers,
      query: this.options.query,
      secrets: this.options.secrets,
      signal: combined,
    });
    if (
      result.status === 'invocation_error' &&
      result.error.code === 'cancelled' &&
      signal?.aborted !== true &&
      this.runController.signal.aborted
    ) {
      const timeout = new AgentInvocationError('timeout', 'Background agent run timed out.');
      const terminal = { ...result, error: timeout };
      result = {
        ...terminal,
        attempts: result.attempts.map((attempt) =>
          attempt.status === 'invocation_error' && attempt.error.code === 'cancelled'
            ? { ...attempt, error: timeout }
            : attempt,
        ),
      };
    }
    const stderr = this.process.stderrExcerpt();
    const diagnostics = {
      ...result.diagnostics,
      ...(stderr === undefined
        ? {}
        : { stderrExcerpt: redactTransportText(stderr, this.options.secrets ?? []) }),
      ...(this.process.child.exitCode === null ? {} : { exitCode: this.process.child.exitCode }),
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
    if (shutdown === undefined || this.process.child.exitCode !== null) return;
    const request: AgentRequest = {
      protocol: AGENT_PROTOCOL,
      run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      case_id: 'shutdown',
      input: {},
    };
    const materialized = materializeHttpRequest(
      {
        ...shutdown,
        headers: {
          ...(shutdown.headers as Record<string, string> | undefined),
          ...this.options.headers,
        },
        query: { ...(shutdown.query as Record<string, string> | undefined), ...this.options.query },
      } as ResolvedHttpRequestTemplate,
      request,
      this.agent.limits?.request_bytes ?? 10 * 1024 * 1024,
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
  assertLoopbackUrl,
  startBackgroundAgent,
  type BackgroundAgentResource,
  type BackgroundSessionOptions,
};
