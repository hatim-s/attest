import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import {
  jsonlBridgeOutputSchema,
  parseAgentResponse,
  type AgentRequest,
  type AgentResource,
} from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { startTimer } from '../../internal/elapsed.js';
import { createRawExcerpt } from '../../internal/raw-excerpt.js';
import type { InvocationAttempt, InvocationResult } from '../../types.js';
import { redactEventEvidence, redactTransportText } from '../http/redaction.js';
import { ManagedChild } from './managed-child.js';

type JsonlBridgeAgentResource = AgentResource & {
  transport: Extract<AgentResource['transport'], { kind: 'jsonl_bridge' }>;
};

type JsonlBridgeSessionOptions = {
  cwd: string;
  env: Record<string, string>;
  secrets?: readonly string[];
  signal?: AbortSignal;
  terminationGraceMs?: number;
};

type PendingInvocation = {
  cancelled: boolean;
  cancellationCode?: 'cancelled' | 'timeout';
  cancellationTimer?: NodeJS.Timeout;
  callerAbort?: () => void;
  duration: () => number;
  request: AgentRequest;
  resolve: (result: InvocationResult) => void;
  signal?: AbortSignal;
  timeoutTimer: NodeJS.Timeout;
};

const DEFAULT_ATTEMPT_MS = 60_000;
const DEFAULT_EVENT_COUNT = 10_000;
const DEFAULT_EVENT_BYTES = 1024 * 1024;
const DEFAULT_TOTAL_EVIDENCE_BYTES = 10 * 1024 * 1024;
const DEFAULT_STDERR_BYTES = 16 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;

/** Derives a bounded correlation token without embedding unbounded authored request identifiers. */
const correlationId = (request: AgentRequest, sequence: number): string => {
  const digest = createHash('sha256')
    .update(request.run_id)
    .update('\0')
    .update(request.case_id)
    .digest('hex')
    .slice(0, 32);
  return `req-${sequence.toString(36)}-${digest}`;
};

/** Runs one persistent, correlated native-agent JSONL bridge for exactly one eval run. */
class JsonlBridgeSession {
  private readonly pending = new Map<string, PendingInvocation>();
  private readonly decoder = new StringDecoder('utf8');
  private readonly secrets: readonly string[];
  private buffer = '';
  private closed = false;
  private closePromise?: Promise<void>;
  private eventCount = 0;
  private sequence = 0;
  private serialTail: Promise<void> = Promise.resolve();
  private totalEvidenceBytes = 0;
  private runTimer?: NodeJS.Timeout;

  private constructor(
    readonly agent: JsonlBridgeAgentResource,
    private readonly process: ManagedChild,
    private readonly options: JsonlBridgeSessionOptions,
  ) {
    this.secrets = options.secrets ?? [];
    process.child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    process.child.stdout.once('end', () => this.consumeEnd());
    void process.exit.then(({ code, signal }) => {
      if (this.closed) return;
      const error =
        code !== 0 || signal !== null
          ? new AgentInvocationError(
              'nonzero_exit',
              `JSONL bridge exited before all requests settled (code ${String(code)}, signal ${String(signal)}).`,
            )
          : new AgentInvocationError(
              'invalid_envelope',
              'JSONL bridge reached EOF before all requests settled.',
            );
      this.failSession(error);
    });
    if (agent.timeouts?.run_ms !== undefined) {
      this.runTimer = setTimeout(
        () => this.failSession(new AgentInvocationError('timeout', 'JSONL bridge run timed out.')),
        agent.timeouts.run_ms,
      );
    }
    options.signal?.addEventListener(
      'abort',
      () =>
        this.failSession(new AgentInvocationError('cancelled', 'JSONL bridge run was cancelled.')),
      { once: true },
    );
  }

  /** Starts a shell-free bridge process with project-resolved cwd and environment. */
  static async start(
    agent: JsonlBridgeAgentResource,
    options: JsonlBridgeSessionOptions,
  ): Promise<JsonlBridgeSession> {
    const process = await ManagedChild.start({
      argv: agent.transport.argv,
      cwd: options.cwd,
      env: options.env,
      stderrCapBytes: Math.min(
        agent.limits?.total_evidence_bytes ?? DEFAULT_STDERR_BYTES,
        DEFAULT_STDERR_BYTES,
      ),
    });
    return new JsonlBridgeSession(agent, process, options);
  }

  /** Queues serial bridges and directly multiplexes bridges that advertise correlation support. */
  async invoke(request: AgentRequest, signal?: AbortSignal): Promise<InvocationResult> {
    if (this.agent.transport.concurrency === 'multiplexed') return this.invokeNow(request, signal);
    let resolveResult!: (result: InvocationResult) => void;
    const result = new Promise<InvocationResult>((resolve) => {
      resolveResult = resolve;
    });
    const scheduled = this.serialTail.then(async () => {
      resolveResult(await this.invokeNow(request, signal));
    });
    this.serialTail = scheduled.catch(() => undefined);
    return result;
  }

  private async invokeNow(request: AgentRequest, signal?: AbortSignal): Promise<InvocationResult> {
    if (this.closed)
      return this.failure(new AgentInvocationError('network', 'JSONL bridge is closed.'), 0);
    if (signal?.aborted === true) {
      return this.failure(
        new AgentInvocationError('cancelled', 'JSONL bridge request was cancelled.'),
        0,
      );
    }
    const requestId = correlationId(request, ++this.sequence);
    const frame = { type: 'request', request_id: requestId, request } as const;
    if (
      Buffer.byteLength(JSON.stringify(frame)) >
      (this.agent.limits?.request_bytes ?? DEFAULT_TOTAL_EVIDENCE_BYTES)
    ) {
      return this.failure(
        new AgentInvocationError(
          'output_cap_exceeded',
          'JSONL bridge request exceeds its request byte cap.',
        ),
        0,
      );
    }
    const duration = startTimer();
    const result = new Promise<InvocationResult>((resolve) => {
      const requestDeadline = Math.min(
        this.agent.timeouts?.first_byte_ms ?? DEFAULT_ATTEMPT_MS,
        this.agent.timeouts?.idle_ms ?? DEFAULT_ATTEMPT_MS,
        this.agent.timeouts?.attempt_ms ?? DEFAULT_ATTEMPT_MS,
      );
      const timeoutTimer = setTimeout(
        () => void this.cancel(requestId, 'timeout'),
        requestDeadline,
      );
      const pending: PendingInvocation = {
        cancelled: false,
        duration,
        request,
        resolve,
        signal,
        timeoutTimer,
      };
      if (signal !== undefined) {
        pending.callerAbort = () => void this.cancel(requestId, 'cancelled');
        signal.addEventListener('abort', pending.callerAbort, { once: true });
      }
      this.pending.set(requestId, pending);
    });
    // Result settlement must remain independent of a peer that stops draining stdin.
    void this.process.writeLine(frame).catch((error: unknown) =>
      this.failSession(
        error instanceof AgentInvocationError
          ? error
          : new AgentInvocationError('network', 'Could not write a JSONL bridge request.', {
              cause: error,
            }),
      ),
    );
    return result;
  }

  private consume(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer += this.decoder.write(chunk);
    const maximumLineBytes = this.agent.limits?.event_bytes ?? DEFAULT_EVENT_BYTES;
    if (Buffer.byteLength(this.buffer) > maximumLineBytes && !this.buffer.includes('\n')) {
      this.failSession(
        new AgentInvocationError(
          'output_cap_exceeded',
          'JSONL bridge line exceeds its event byte cap.',
        ),
      );
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      this.consumeLine(line);
      if (this.closed) return;
    }
  }

  private consumeEnd(): void {
    if (this.closed) return;
    this.buffer += this.decoder.end();
    if (this.buffer.trim().length > 0) this.consumeLine(this.buffer.replace(/\r$/u, ''));
    this.buffer = '';
  }

  private consumeLine(line: string): void {
    const bytes = Buffer.byteLength(line);
    this.eventCount += 1;
    this.totalEvidenceBytes += bytes;
    if (bytes > (this.agent.limits?.event_bytes ?? DEFAULT_EVENT_BYTES)) {
      this.failSession(
        new AgentInvocationError(
          'output_cap_exceeded',
          'JSONL bridge line exceeds its event byte cap.',
        ),
      );
      return;
    }
    if (this.eventCount > (this.agent.limits?.event_count ?? DEFAULT_EVENT_COUNT)) {
      this.failSession(
        new AgentInvocationError(
          'output_cap_exceeded',
          'JSONL bridge exceeds its event count cap.',
        ),
      );
      return;
    }
    if (
      this.totalEvidenceBytes >
      (this.agent.limits?.total_evidence_bytes ?? DEFAULT_TOTAL_EVIDENCE_BYTES)
    ) {
      this.failSession(
        new AgentInvocationError(
          'output_cap_exceeded',
          'JSONL bridge exceeds its aggregate evidence cap.',
        ),
      );
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch (error: unknown) {
      this.failSession(
        new AgentInvocationError(
          'invalid_envelope',
          'JSONL bridge stdout contains non-JSON data.',
          { cause: error },
        ),
      );
      return;
    }
    const parsed = jsonlBridgeOutputSchema.safeParse(raw);
    if (!parsed.success) {
      this.failSession(
        new AgentInvocationError(
          'invalid_envelope',
          'JSONL bridge emitted an invalid output envelope.',
        ),
      );
      return;
    }
    const pending = this.pending.get(parsed.data.request_id);
    if (pending === undefined) {
      this.failSession(
        new AgentInvocationError(
          'invalid_envelope',
          'JSONL bridge emitted an unknown or duplicate request id.',
        ),
      );
      return;
    }
    if (parsed.data.type === 'cancelled') {
      if (!pending.cancelled) {
        this.failSession(
          new AgentInvocationError(
            'invalid_envelope',
            'JSONL bridge acknowledged cancellation that was not requested.',
          ),
        );
        return;
      }
      this.settle(
        parsed.data.request_id,
        this.failure(
          new AgentInvocationError(
            pending.cancellationCode ?? 'cancelled',
            pending.cancellationCode === 'timeout'
              ? 'JSONL bridge request timed out.'
              : 'JSONL bridge request was cancelled.',
          ),
          pending.duration(),
          line,
        ),
      );
      return;
    }
    if (pending.cancelled) {
      this.settle(
        parsed.data.request_id,
        this.failure(
          new AgentInvocationError(
            pending.cancellationCode ?? 'cancelled',
            pending.cancellationCode === 'timeout'
              ? 'JSONL bridge request timed out.'
              : 'JSONL bridge request was cancelled.',
          ),
          pending.duration(),
          line,
        ),
      );
      return;
    }
    const report = parseAgentResponse(parsed.data.response);
    if (!report.ok) {
      this.settle(
        parsed.data.request_id,
        this.failure(
          new AgentInvocationError(
            'invalid_envelope',
            'JSONL bridge response is not a valid native envelope.',
          ),
          pending.duration(),
          line,
        ),
      );
      return;
    }
    const attempt: InvocationAttempt = {
      status: 'ok',
      raw: parsed.data.response,
      report,
      diagnostics: this.diagnostics(),
      durationMs: pending.duration(),
      rawExcerpt: createRawExcerpt(
        redactEventEvidence(raw, this.agent.redaction?.event_pointers ?? [], this.secrets),
      ),
      warnings: report.warnings,
    };
    this.settle(parsed.data.request_id, { ...attempt, attempts: [attempt] });
  }

  private async cancel(requestId: string, code: 'cancelled' | 'timeout'): Promise<void> {
    const pending = this.pending.get(requestId);
    if (pending === undefined || pending.cancelled) return;
    pending.cancelled = true;
    pending.cancellationCode = code;
    clearTimeout(pending.timeoutTimer);
    const cancellationGrace = this.agent.transport.cancellation_grace_ms;
    pending.cancellationTimer = setTimeout(
      () => this.fallbackAfterCancellation(requestId, code),
      cancellationGrace,
    );
    try {
      // The same grace bounds both stdin backpressure and the peer acknowledgement.
      await this.process.writeLine(
        { type: 'cancel', request_id: requestId },
        AbortSignal.timeout(cancellationGrace),
      );
    } catch (error: unknown) {
      this.fallbackAfterCancellation(requestId, code, error);
    }
  }

  private fallbackAfterCancellation(
    requestId: string,
    code: 'cancelled' | 'timeout',
    cause?: unknown,
  ): void {
    const pending = this.pending.get(requestId);
    if (pending !== undefined) {
      this.settle(
        requestId,
        this.failure(
          new AgentInvocationError(
            code,
            code === 'timeout'
              ? 'JSONL bridge request timed out.'
              : 'JSONL bridge request was cancelled.',
            { cause },
          ),
          pending.duration(),
        ),
      );
    }
    this.failSession(
      new AgentInvocationError(
        'invalid_envelope',
        'JSONL bridge did not settle in-band cancellation; the process fallback was used.',
      ),
    );
  }

  private settle(requestId: string, result: InvocationResult): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    clearTimeout(pending.timeoutTimer);
    if (pending.cancellationTimer !== undefined) clearTimeout(pending.cancellationTimer);
    if (pending.callerAbort !== undefined) {
      // AbortSignal listeners are one-shot, but explicit removal avoids retaining completed requests.
      pending.signal?.removeEventListener('abort', pending.callerAbort);
    }
    this.pending.delete(requestId);
    pending.resolve(result);
  }

  private failure(
    error: AgentInvocationError,
    durationMs: number,
    evidence = '',
  ): InvocationResult {
    const attempt: InvocationAttempt = {
      status: 'invocation_error',
      error,
      diagnostics: this.diagnostics(),
      durationMs,
      rawExcerpt: createRawExcerpt(redactTransportText(evidence, this.secrets)),
      warnings: [],
    };
    return { ...attempt, attempts: [attempt] };
  }

  private diagnostics(): InvocationAttempt['diagnostics'] {
    const stderr = this.process.stderrExcerpt();
    return stderr === undefined ? {} : { stderrExcerpt: redactTransportText(stderr, this.secrets) };
  }

  private failSession(error: AgentInvocationError): void {
    if (this.closed) return;
    this.closed = true;
    if (this.runTimer !== undefined) clearTimeout(this.runTimer);
    for (const [requestId, pending] of this.pending) {
      const requestError =
        pending.cancelled && pending.cancellationCode !== undefined
          ? new AgentInvocationError(
              pending.cancellationCode,
              pending.cancellationCode === 'timeout'
                ? 'JSONL bridge request timed out.'
                : 'JSONL bridge request was cancelled.',
            )
          : error;
      this.settle(requestId, this.failure(requestError, pending.duration()));
    }
    this.closePromise = this.process
      .terminate(
        this.options.terminationGraceMs ??
          Math.min(DEFAULT_TERMINATION_GRACE_MS, this.agent.transport.cancellation_grace_ms),
      )
      .then(() => undefined);
  }

  /** Ends the run-scoped bridge and guarantees process-tree cleanup. */
  async close(): Promise<void> {
    if (!this.closed)
      this.failSession(new AgentInvocationError('cancelled', 'JSONL bridge session closed.'));
    await this.closePromise;
  }
}

const startJsonlBridgeAgent = (
  agent: JsonlBridgeAgentResource,
  options: JsonlBridgeSessionOptions,
): Promise<JsonlBridgeSession> => JsonlBridgeSession.start(agent, options);

export {
  JsonlBridgeSession,
  startJsonlBridgeAgent,
  type JsonlBridgeAgentResource,
  type JsonlBridgeSessionOptions,
};
