import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Deferred from 'effect/Deferred';
import * as Queue from 'effect/Queue';
import * as Semaphore from 'effect/Semaphore';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Scope from 'effect/Scope';
import { ProcessCleanupDiagnostics, ProcessCleanupError } from './process-cleanup.js';
import * as Fiber from 'effect/Fiber';
import { parseJson } from '../../internal/json-value.js';
import { StringDecoder } from 'node:string_decoder';

import {
  parseWithSchema,
  jsonlBridgeOutputSchema,
  parseAgentResponse,
  type AgentRequest,
  type AgentResource,
  type JsonValue,
} from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import {
  DEFAULT_ATTEMPT_MS,
  DEFAULT_EVENT_BYTES,
  DEFAULT_EVENT_COUNT,
  DEFAULT_REQUEST_BYTES,
  DEFAULT_STDERR_BYTES,
  DEFAULT_TERMINATION_GRACE_MS,
  DEFAULT_TOTAL_EVIDENCE_BYTES,
} from '../../internal/agent-defaults.js';
import { correlationId } from '../../internal/correlation-id.js';
import { LineSplitter, type SplitLines } from '../../internal/line-splitter.js';
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

type CancellationCode = 'cancelled' | 'timeout';

type PendingInvocation = {
  /** Why attest cancelled the request; absent until it does. */
  cancellation?: CancellationCode;
  cancellationTimer?: NodeJS.Timeout;
  callerAbort?: () => void;
  duration: () => number;
  request: AgentRequest;
  resolve: (result: InvocationResult) => void;
  defect: (cause: Cause.Cause<never>) => void;
  signal?: AbortSignal;
  timeoutTimer: NodeJS.Timeout;
};

type ProcessOutput =
  | { kind: 'chunk'; chunk: Buffer }
  | { kind: 'end' }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null };

type ParsedOutput = { output: typeof jsonlBridgeOutputSchema.Type; raw: JsonValue };

const capError = (message: string): AgentInvocationError =>
  new AgentInvocationError('output_cap_exceeded', message);

/** Reports a request that attest stopped, either on caller cancellation or on its deadline. */
const cancellationError = (code: CancellationCode, cause?: unknown): AgentInvocationError =>
  new AgentInvocationError(
    code,
    code === 'timeout' ? 'JSONL bridge request timed out.' : 'JSONL bridge request was cancelled.',
    cause === undefined ? {} : { cause },
  );

/** Runs one persistent, correlated native-agent JSONL bridge for exactly one eval run. */
class JsonlBridgeSession {
  private reader?: Fiber.Fiber<never, never>;
  private writer?: Fiber.Fiber<never, never>;
  private completed?: InvocationResult;
  readonly cleanupExits: Exit.Exit<unknown, unknown>[] = [];
  private readonly pending = new Map<string, PendingInvocation>();
  private readonly decoder = new StringDecoder('utf8');
  private readonly secrets: readonly string[];
  private readonly lines: LineSplitter;
  private closed = false;
  private readonly stopped = Deferred.makeUnsafe<void>();
  private readonly cleanup = Deferred.makeUnsafe<void, AgentInvocationError>();
  private readonly writes: Queue.Queue<{
    frame: Parameters<ManagedChild['writeLine']>[0];
    signal?: AbortSignal;
  }>;
  private readonly serial = Semaphore.makeUnsafe(1);
  private readonly callerAbort = (): void =>
    this.failSession(new AgentInvocationError('cancelled', 'JSONL bridge run was cancelled.'));
  private eventCount = 0;
  private sequence = 0;
  private totalEvidenceBytes = 0;
  private runTimer?: NodeJS.Timeout;

  private constructor(
    readonly agent: JsonlBridgeAgentResource,
    private readonly process: ManagedChild,
    private readonly options: JsonlBridgeSessionOptions,
    private readonly outputs: Queue.Queue<ProcessOutput>,
    writes: Queue.Queue<{ frame: Parameters<ManagedChild['writeLine']>[0]; signal?: AbortSignal }>,
  ) {
    this.writes = writes;
    this.secrets = options.secrets ?? [];
    this.lines = new LineSplitter(agent.limits?.event_bytes ?? DEFAULT_EVENT_BYTES);
    process.stdout.on('data', (chunk: Buffer) => this.enqueueOutput({ kind: 'chunk', chunk }));
    process.stdout.once('end', () => this.enqueueOutput({ kind: 'end' }));

    if (agent.timeouts?.run_ms !== undefined) {
      this.runTimer = setTimeout(
        () => this.failSession(new AgentInvocationError('timeout', 'JSONL bridge run timed out.')),
        agent.timeouts.run_ms,
      );
    }

    options.signal?.addEventListener('abort', this.callerAbort, { once: true });
  }

  /** Starts a shell-free process and immediately registers scope-owned cleanup. */
  static start = Effect.fn('JsonlBridgeSession.start')(function* (
    agent: JsonlBridgeAgentResource,
    options: JsonlBridgeSessionOptions,
  ) {
    if (options.signal?.aborted === true)
      return yield* Effect.fail(
        new AgentInvocationError('cancelled', 'JSONL bridge run was cancelled.'),
      );

    const process = yield* ManagedChild.start({
      argv: agent.transport.argv,
      cwd: options.cwd,
      env: options.env,
      stderrCapBytes: Math.min(
        agent.limits?.total_evidence_bytes ?? DEFAULT_STDERR_BYTES,
        DEFAULT_STDERR_BYTES,
      ),
    });

    const session = new JsonlBridgeSession(
      agent,
      process,
      options,
      yield* Queue.bounded<ProcessOutput>(256),
      yield* Queue.bounded<{
        frame: Parameters<ManagedChild['writeLine']>[0];
        signal?: AbortSignal;
      }>(256),
    );

    // Close must settle cleanup before its worker is interrupted, even in a parallel parent.
    const scope = yield* Scope.fork(yield* Effect.scope, 'sequential');
    // The cleanup worker retains its Exit even when automatic shutdown precedes explicit close.
    yield* session.release().pipe(
      Effect.onExit((exit) => Effect.sync(() => Deferred.doneUnsafe(session.cleanup, exit))),
      Effect.interruptible,
      Effect.forkIn(scope),
    );
    yield* Scope.addFinalizer(scope, Effect.asVoid(Effect.exit(session.close())));
    session.writer = yield* Effect.forever(
      Effect.gen(function* () {
        const { frame, signal } = yield* Queue.take(session.writes);
        yield* process
          .writeLine(frame, signal)
          .pipe(Effect.catch((error) => Effect.sync(() => session.failSession(error))));
      }),
    ).pipe(Effect.interruptible, Effect.forkIn(scope));
    session.reader = yield* Effect.forever(
      Effect.gen(function* () {
        const output = yield* Queue.take(session.outputs);
        yield* Effect.sync(() => {
          if (output.kind === 'chunk') session.consume(output.chunk);
          else if (output.kind === 'end') session.consumeEnd();
          else
            session.failSession(
              new AgentInvocationError(
                output.code !== 0 || output.signal !== null ? 'nonzero_exit' : 'invalid_envelope',
                `JSONL bridge exited before all requests settled (code ${String(output.code)}, signal ${String(output.signal)}).`,
              ),
            );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              for (const pending of session.pending.values()) pending.defect(cause);
              session.failSession(
                new AgentInvocationError('network', 'JSONL bridge framing failed.'),
              );
            }),
          ),
        );
      }),
    ).pipe(Effect.interruptible, Effect.forkIn(scope));
    yield* Effect.gen(function* () {
      const { code, signal } = yield* Deferred.await(process.exit);
      session.enqueueOutput({ kind: 'exit', code, signal });
    }).pipe(Effect.interruptible, Effect.forkIn(scope));

    if (options.signal?.aborted) {
      const failure = new AgentInvocationError('cancelled', 'JSONL bridge run was cancelled.');
      const primary = Cause.fail(failure);
      const cleanup = yield* Effect.exit(session.close());

      if (Exit.isFailure(cleanup)) {
        failure.cause = { cleanupFailure: Cause.squash(cleanup.cause) };

        return yield* Effect.failCause(
          Cause.annotate(primary, Context.make(ProcessCleanupDiagnostics, cleanup.cause)),
        );
      }

      return yield* Effect.fail(failure);
    }

    return session;
  }, Effect.uninterruptible);

  /** Queues serial bridges and directly multiplexes bridges that advertise correlation support. */
  invoke(request: AgentRequest, signal?: AbortSignal) {
    const operation = this.invokeNow(request, signal);

    return this.agent.transport.concurrency === 'multiplexed'
      ? operation
      : this.serial.withPermit(operation);
  }

  /** Owns settlement until protocol acknowledgement or fallback, even after fiber interruption. */
  private invokeNow = Effect.fn('JsonlBridgeSession.invoke')(function* (
    this: JsonlBridgeSession,
    request: AgentRequest,
    signal?: AbortSignal,
  ) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(
        function* (this: JsonlBridgeSession) {
          if (this.closed)
            return this.failure(new AgentInvocationError('network', 'JSONL bridge is closed.'), 0);

          if (signal?.aborted === true) {
            return this.failure(cancellationError('cancelled'), 0);
          }

          if (this.pending.size >= 256)
            return this.failure(capError('JSONL bridge pending request cap exceeded.'), 0);

          const requestId = correlationId('req', request, ++this.sequence);
          const frame = { type: 'request', request_id: requestId, request } as const;

          if (
            Buffer.byteLength(JSON.stringify(frame)) >
            (this.agent.limits?.request_bytes ?? DEFAULT_REQUEST_BYTES)
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

          const result = Deferred.makeUnsafe<InvocationResult>();

          const resolve = (value: InvocationResult): void => {
            Deferred.doneUnsafe(result, Effect.succeed(value));
          };

          {
            const requestDeadline = Math.min(
              this.agent.timeouts?.first_byte_ms ?? DEFAULT_ATTEMPT_MS,
              this.agent.timeouts?.idle_ms ?? DEFAULT_ATTEMPT_MS,
              this.agent.timeouts?.attempt_ms ?? DEFAULT_ATTEMPT_MS,
            );

            const timeoutTimer = setTimeout(
              () => this.cancel(requestId, 'timeout'),
              requestDeadline,
            );

            const pending: PendingInvocation = {
              duration,
              defect: (cause) => {
                Deferred.doneUnsafe(result, Effect.failCause(cause));
              },
              request,
              resolve,
              signal,
              timeoutTimer,
            };

            if (signal !== undefined) {
              pending.callerAbort = () => this.cancel(requestId, 'cancelled');
              signal.addEventListener('abort', pending.callerAbort, { once: true });
            }

            this.pending.set(requestId, pending);

            if (signal?.aborted) this.cancel(requestId, 'cancelled');
          }

          this.enqueueWrite(frame);

          // Interrupting an observer requests business cancellation and joins its terminal evidence.
          const primary = yield* Effect.exit(
            restore(Deferred.await(result)).pipe(
              Effect.onInterrupt(() =>
                Effect.gen(
                  function* (this: JsonlBridgeSession) {
                    this.cancel(requestId, 'cancelled');
                    yield* Deferred.await(result);
                  }.bind(this),
                ),
              ),
            ),
          );

          if (Exit.isFailure(primary)) {
            if (this.closed || Cause.hasDies(primary.cause)) {
              const cleanup = yield* Effect.exit(this.close());

              return yield* Effect.failCause(
                Exit.isFailure(cleanup)
                  ? Cause.annotate(
                      primary.cause,
                      Context.make(ProcessCleanupDiagnostics, cleanup.cause),
                    )
                  : primary.cause,
              );
            }

            return yield* Effect.failCause(primary.cause);
          }

          return primary.value;
        }.bind(this),
      ),
    );
  });

  /** Keeps framing in a scoped worker, preserving stdout/end/close order. */
  private enqueueOutput(output: ProcessOutput): void {
    if (!this.closed && !Queue.offerUnsafe(this.outputs, output))
      this.failSession(capError('JSONL bridge output queue exceeds its cap.'));
  }

  /** Bounds queued frames; overflow ends ownership rather than dropping an unknown dispatch. */
  private enqueueWrite(
    frame: Parameters<ManagedChild['writeLine']>[0],
    signal?: AbortSignal,
  ): void {
    if (!Queue.offerUnsafe(this.writes, { frame, signal }))
      this.failSession(capError('JSONL bridge pending write queue exceeds its cap.'));
  }

  private consume(chunk: Buffer): void {
    if (this.closed) return;
    this.consumeLines(this.lines.push(this.decoder.write(chunk)));
  }

  private consumeEnd(): void {
    if (this.closed) return;
    this.consumeLines(this.lines.push(this.decoder.end()));

    if (!this.closed) this.consumeLines(this.lines.end());
  }

  private consumeLines({ lines, overflow }: SplitLines): void {
    for (const line of lines) {
      if (line.trim().length > 0) this.consumeLine(line);

      if (this.closed) return;
    }

    if (overflow) {
      this.failSession(capError('JSONL bridge line exceeds its event byte cap.'));
    }
  }

  /** Counts one output line against the session caps; returns the cap it broke, if any. */
  private checkCaps(line: string): AgentInvocationError | undefined {
    this.eventCount += 1;
    this.totalEvidenceBytes += Buffer.byteLength(line);

    if (this.eventCount > (this.agent.limits?.event_count ?? DEFAULT_EVENT_COUNT)) {
      return capError('JSONL bridge exceeds its event count cap.');
    }

    const totalCap = this.agent.limits?.total_evidence_bytes ?? DEFAULT_TOTAL_EVIDENCE_BYTES;

    if (this.totalEvidenceBytes > totalCap) {
      return capError('JSONL bridge exceeds its aggregate evidence cap.');
    }

    return undefined;
  }

  /** Parses one line into a bridge output envelope, or the protocol error that ends the session. */
  private parseOutput(line: string): ParsedOutput | AgentInvocationError {
    let raw: JsonValue;

    try {
      raw = parseJson(line);
    } catch (error: unknown) {
      return new AgentInvocationError(
        'invalid_envelope',
        'JSONL bridge stdout contains non-JSON data.',
        { cause: error },
      );
    }

    const parsed = parseWithSchema(jsonlBridgeOutputSchema, raw);

    if (!parsed.ok) {
      return new AgentInvocationError(
        'invalid_envelope',
        'JSONL bridge emitted an invalid output envelope.',
      );
    }

    return { output: parsed.value, raw };
  }

  private consumeLine(line: string): void {
    const capFailure = this.checkCaps(line);

    if (capFailure !== undefined) {
      this.failSession(capFailure);

      return;
    }

    const parsed = this.parseOutput(line);

    if (parsed instanceof AgentInvocationError) {
      this.failSession(parsed);

      return;
    }

    const { output, raw } = parsed;
    const pending = this.pending.get(output.request_id);

    if (pending === undefined) {
      this.failSession(
        new AgentInvocationError(
          'invalid_envelope',
          'JSONL bridge emitted an unknown or duplicate request id.',
        ),
      );

      return;
    }

    if (output.type === 'cancelled' && pending.cancellation === undefined) {
      this.failSession(
        new AgentInvocationError(
          'invalid_envelope',
          'JSONL bridge acknowledged cancellation that was not requested.',
        ),
      );

      return;
    }

    // After attest cancels, both the acknowledgement and a late response settle as cancelled.
    if (output.type === 'cancelled' || pending.cancellation !== undefined) {
      this.settleCancellation(output.request_id, pending, line);

      return;
    }

    const report = parseAgentResponse(output.response);

    if (!report.ok) {
      this.settle(
        output.request_id,
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
      raw: output.response,
      report,
      diagnostics: this.diagnostics(),
      durationMs: pending.duration(),
      rawExcerpt: createRawExcerpt(
        redactEventEvidence(raw, this.agent.redaction?.event_pointers ?? [], this.secrets),
      ),
      warnings: report.warnings,
    };

    this.settle(output.request_id, { ...attempt, attempts: [attempt] });
  }

  private settleCancellation(requestId: string, pending: PendingInvocation, line: string): void {
    this.settle(
      requestId,
      this.failure(
        cancellationError(pending.cancellation ?? 'cancelled'),
        pending.duration(),
        line,
      ),
    );
  }

  private cancel(requestId: string, code: CancellationCode): void {
    const pending = this.pending.get(requestId);

    if (pending === undefined || pending.cancellation !== undefined) return;
    pending.cancellation = code;
    clearTimeout(pending.timeoutTimer);
    const cancellationGrace = this.agent.transport.cancellation_grace_ms;
    pending.cancellationTimer = setTimeout(
      () => this.fallbackAfterCancellation(requestId, code),
      cancellationGrace,
    );

    // The grace timer owns fallback even if a prior write is blocked on backpressure.
    this.enqueueWrite(
      { type: 'cancel', request_id: requestId },
      AbortSignal.timeout(cancellationGrace),
    );
  }

  private fallbackAfterCancellation(
    requestId: string,
    code: CancellationCode,
    cause?: unknown,
  ): void {
    const pending = this.pending.get(requestId);

    if (pending !== undefined) {
      this.settle(requestId, this.failure(cancellationError(code, cause), pending.duration()));
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
    this.completed = result;
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
        pending.cancellation === undefined ? error : cancellationError(pending.cancellation);

      this.settle(requestId, this.failure(requestError, pending.duration()));
    }

    Deferred.doneUnsafe(this.stopped, Effect.void);
  }

  /** Records automatic teardown as a Deferred Exit, avoiding detached Promise rejection. */
  private release = Effect.fn('JsonlBridgeSession.release')(function* (this: JsonlBridgeSession) {
    yield* Effect.interruptible(Deferred.await(this.stopped));

    const joined = yield* Effect.exit(
      this.writer === undefined ? Effect.void : Fiber.interrupt(this.writer),
    );

    const readerJoined = yield* Effect.exit(
      this.reader === undefined ? Effect.void : Fiber.interrupt(this.reader),
    );

    const detached = yield* Effect.exit(
      Effect.sync(() => {
        this.options.signal?.removeEventListener('abort', this.callerAbort);
        Queue.shutdownUnsafe(this.writes);
        Queue.shutdownUnsafe(this.outputs);
      }),
    );

    const terminated = yield* Effect.exit(
      this.process.terminate(
        this.options.terminationGraceMs ??
          Math.min(DEFAULT_TERMINATION_GRACE_MS, this.agent.transport.cancellation_grace_ms),
      ),
    );

    this.cleanupExits.push(joined, readerJoined, detached, terminated);

    if (this.cleanupExits.some(Exit.isFailure))
      return yield* Effect.fail(new ProcessCleanupError(this.cleanupExits, this.completed));
  }, Effect.uninterruptible);

  /** Stops admission and awaits the original automatic cleanup outcome. */
  close() {
    return Effect.uninterruptible(
      Effect.gen(
        function* (this: JsonlBridgeSession) {
          if (!this.closed)
            this.failSession(new AgentInvocationError('cancelled', 'JSONL bridge session closed.'));
          yield* Deferred.await(this.cleanup);
        }.bind(this),
      ),
    );
  }
}

/** Opens a bridge in the caller's retained run scope. */
const startJsonlBridgeAgent = JsonlBridgeSession.start;

export {
  JsonlBridgeSession,
  startJsonlBridgeAgent,
  type JsonlBridgeAgentResource,
  type JsonlBridgeSessionOptions,
};
