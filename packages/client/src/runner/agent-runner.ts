import { Cause, Effect, Exit, Fiber, FiberSet, Scope } from 'effect';
import {
  foreignMessage,
  parseWithSchema,
  AGENT_COMPLETION_PROTOCOL,
  DEFAULT_REQUEST_BYTES,
  agentCompletionSchema,
  parseAgentRequest,
  type AgentCallback,
  type AgentErrorResponse,
  type AgentRequest,
  type Artifact,
  type JsonValue,
  type Trace,
} from '@attest/contracts';

import { ClientCleanup, ClientCleanupError, withCleanup } from './lifetime.js';
import { deliverCompletion, type DeliveryOutcome } from './deliver-completion.js';
import { readBoundedText } from './read-bounded-text.js';
import { AgentHandlerError, AgentRunnerError, RunnerIoError } from './runner-errors.js';
import { tokensMatch } from './tokens-match.js';

/** A validated trigger. The runner only accepts requests that say where to post the result. */
type AgentInvocation = AgentRequest & { callback: AgentCallback };

type AgentError = AgentErrorResponse['error'];

type HandlerOutcome = { output: JsonValue } | { error: AgentError };

/** What a handler returns; the runner adds the protocol, run and case ids. */
type HandlerResult = HandlerOutcome & {
  artifacts?: Artifact[];
  trace?: Trace;
  trace_ref?: string;
  state?: JsonValue;
};

type HandlerContext = {
  /** Aborts when the runner closes. Attest has no remote cancellation in v1. */
  signal: AbortSignal;
};

type AgentHandler = (
  invocation: AgentInvocation,
  context: HandlerContext,
) => Effect.Effect<HandlerResult, AgentHandlerError>;

/** A background failure the trigger response could not report, because it was already sent. */
type RunnerFailure = {
  kind: 'handler_failed' | 'invalid_completion' | 'delivery_failed';
  runId: string;
  caseId: string;
  message: string;
};

type AgentRunnerOptions = {
  handler: AgentHandler;
  /** Maximum trigger body size in bytes. Defaults to 10 MiB. */
  requestBodyLimitBytes?: number;
  /** Posts completions. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Receives background failures. Defaults to one line on stderr. */
  onError?: (failure: RunnerFailure) => void;
  /**
   * Every trigger must carry `Authorization: Bearer <triggerToken>`. A trigger makes the handler
   * run a prompt, and binding to loopback does not stop a DNS-rebinding page from reaching it.
   */
  triggerToken: string;
};

/**
 * Failures while reading a trigger body; every other trigger problem is an HTTP response.
 * `RunnerIoError` is a failed body read or cancel, `Cause.TimeoutError` a read that stalled.
 * `ClientCleanupError` means the body was read in full but cancelling the reader failed afterwards;
 * the error keeps the read text in `success`, and `/node` still answers 500.
 */
type RunnerFetchError = RunnerIoError | Cause.TimeoutError | ClientCleanupError;

type InvocationReceipt = {
  handlerExit?: Exit.Exit<HandlerResult, AgentHandlerError>;
  /** Accepted work reports handler failures as completions, so only defects and interruption remain. */
  exit?: Exit.Exit<void>;
  delivery?: DeliveryOutcome;
};

type AgentRunner = {
  fetch: (request: Request) => Effect.Effect<Response, RunnerFetchError>;
  pending: () => number;
  drain: () => Effect.Effect<void, AgentRunnerError>;
  close: () => Effect.Effect<void, AgentRunnerError>;
  /** Internal terminal evidence. Tokens and Causes must never be serialized. */
  receipts: ReadonlyMap<string, InvocationReceipt>;
  /** Scope release evidence is separate from caller-controlled registration tokens. */
  shutdown: { exit?: Exit.Exit<void, AgentRunnerError> };
};

const reportToStderr = (failure: RunnerFailure): void => {
  console.error(
    `[attest-client] ${failure.kind} run=${failure.runId} case=${failure.caseId}: ${failure.message}`,
  );
};

/** Parses the trigger body, or returns `undefined` when it is not JSON at all. */
const parseTrigger = (text: string): ReturnType<typeof parseAgentRequest> | undefined => {
  try {
    return parseAgentRequest(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/**
 * Creates a runner that accepts `attest.agent-invocation` triggers carrying a `callback`, answers
 * 202 at once, runs the handler in the background and posts an `attest.agent-completion` to the
 * callback URL. A typed handler failure becomes an error completion with code `handler_failed`; a result
 * that fails the completion schema becomes one with code `invalid_completion`, so attest always
 * hears back instead of waiting for its attempt timeout.
 */
const createAgentRunner = ({
  handler,
  requestBodyLimitBytes = DEFAULT_REQUEST_BYTES,
  fetch: fetchImpl = globalThis.fetch,
  onError = reportToStderr,
  triggerToken,
}: AgentRunnerOptions): Effect.Effect<AgentRunner, AgentRunnerError, Scope.Scope> =>
  Effect.gen(function* () {
    /**
     * BOUNDARY: untyped JavaScript callers can omit the token, and `Bearer undefined` must never
     * authenticate a trigger.
     */
    const tokenMissing = typeof triggerToken !== 'string' || triggerToken === '';

    if (tokenMissing) return yield* new AgentRunnerError({ reason: 'missing_trigger_token' });

    // BOUNDARY: JavaScript callers can pass invalid configuration.
    if (!Number.isSafeInteger(requestBodyLimitBytes) || requestBodyLimitBytes <= 0)
      return yield* new AgentRunnerError({ reason: 'invalid_request_body_limit' });
    const fibers = yield* FiberSet.make<void>();
    const inFlight = new Map<string, Fiber.Fiber<void>>();
    const receipts = new Map<string, InvocationReceipt>();
    const shutdown: AgentRunner['shutdown'] = {};
    const closing = new AbortController();

    const settleHandler = (invocation: AgentInvocation) =>
      Effect.suspend(() => handler(invocation, { signal: closing.signal })).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            const receipt = receipts.get(invocation.callback.token);

            if (receipt !== undefined) receipt.handlerExit = exit;
          }),
        ),
        Effect.raceFirst(
          Effect.callback<HandlerResult>((resume) => {
            const cancel = () =>
              resume(
                Effect.sleep(3_000).pipe(
                  Effect.as({
                    error: {
                      code: 'cancelled',
                      message: 'The runner closed before the handler finished.',
                    },
                  }),
                ),
              );

            closing.signal.addEventListener('abort', cancel, { once: true });

            if (closing.signal.aborted) cancel();

            return Effect.sync(() => closing.signal.removeEventListener('abort', cancel));
          }),
        ),
        Effect.catch((error) => {
          if (closing.signal.aborted)
            return Effect.succeed({
              error: {
                code: 'cancelled',
                message: 'The runner closed before the handler finished.',
              },
            });
          onError({
            kind: 'handler_failed',
            runId: invocation.run_id,
            caseId: invocation.case_id,
            message: error.message,
          });

          return Effect.succeed({ error: { code: 'handler_failed', message: error.message } });
        }),
      );

    /** Serializes the completion, replacing a result the receiver would reject with an error. */
    const serializeCompletion = (invocation: AgentInvocation, result: HandlerResult): string => {
      const ids = {
        protocol: AGENT_COMPLETION_PROTOCOL,
        run_id: invocation.run_id,
        case_id: invocation.case_id,
      };

      const invalid = (message: string): string => {
        onError({ kind: 'invalid_completion', runId: ids.run_id, caseId: ids.case_id, message });

        return JSON.stringify({ ...ids, error: { code: 'invalid_completion', message } });
      };

      const checked = parseWithSchema(agentCompletionSchema, { ...ids, ...result });

      if (!checked.ok) {
        return invalid(
          checked.error.issues
            .map((issue) => `${issue.path.map(String).join('.') || '$'}: ${issue.message}`)
            .join('; '),
        );
      }

      // The schema leaves `trace` unvalidated, so a cycle or a bigint in it throws here.
      try {
        return JSON.stringify(checked.value);
      } catch (error) {
        return invalid(`completion is not serializable: ${foreignMessage(error, String(error))}`);
      }
    };

    const run = (invocation: AgentInvocation) =>
      Effect.gen(function* () {
        const body = serializeCompletion(invocation, yield* settleHandler(invocation));

        const outcome = yield* deliverCompletion(
          fetchImpl,
          invocation.callback,
          body,
          closing.signal,
        );

        const receipt = receipts.get(invocation.callback.token);

        if (receipt !== undefined) receipt.delivery = outcome;

        if (!outcome.delivered)
          onError({
            kind: 'delivery_failed',
            runId: invocation.run_id,
            caseId: invocation.case_id,
            message: outcome.reason,
          });
      });

    /** Admission is atomic with forking into the runner scope, never the request scope. */
    const accept = (invocation: AgentInvocation) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (closing.signal.aborted) return Response.json({ error: 'closing' }, { status: 503 });
          const key = invocation.callback.token;

          if (!receipts.has(key)) {
            if (inFlight.size >= 64) return Response.json({ error: 'capacity' }, { status: 503 });

            // Evict only terminal work, keeping active registrations and recent retry identities.
            if (receipts.size >= 10_000) {
              for (const [token, retained] of receipts) {
                if (retained.exit !== undefined) {
                  receipts.delete(token);
                  break;
                }
              }
            }

            if (receipts.size >= 10_000)
              return Response.json({ error: 'capacity' }, { status: 503 });
            const receipt: InvocationReceipt = {};
            receipts.set(key, receipt);

            const fiber = yield* FiberSet.run(
              fibers,
              run(invocation).pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    receipt.exit = exit;
                    inFlight.delete(key);
                  }),
                ),
              ),
            );

            if (receipt.exit === undefined) inFlight.set(key, fiber);
          }

          return Response.json(
            { accepted: true, run_id: invocation.run_id, case_id: invocation.case_id },
            { status: 202 },
          );
        }),
      );

    /** Bounds observation without discarding retained terminal exits. */
    const drain = () =>
      Effect.gen(function* () {
        const joined = yield* Effect.forEach([...inFlight.values()], Fiber.await, {
          concurrency: 'unbounded',
        }).pipe(Effect.timeoutOption(35_000));

        if (joined._tag === 'None')
          return yield* new AgentRunnerError({ reason: 'drain_timed_out' });

        for (const receipt of receipts.values()) {
          if (receipt.exit !== undefined && Exit.isFailure(receipt.exit))
            return yield* Effect.failCause(receipt.exit.cause);
        }
      });

    const close = () =>
      Effect.gen(function* () {
        closing.abort();
        const primary = yield* Effect.exit(drain());
        yield* Effect.forEach([...inFlight.values()], Fiber.interrupt, {
          concurrency: 'unbounded',
        });

        return yield* primary;
      });

    yield* Effect.addFinalizer(() =>
      close().pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            shutdown.exit = Exit.failCause(cause);
          }),
        ),
      ),
    );

    return {
      fetch: (request) =>
        Effect.gen(function* () {
          if (new URL(request.url).pathname !== '/') {
            return Response.json({ error: 'not_found' }, { status: 404 });
          }

          if (request.method !== 'POST') {
            return Response.json(
              { error: 'method_not_allowed' },
              { status: 405, headers: { allow: 'POST' } },
            );
          }

          if (closing.signal.aborted) return Response.json({ error: 'closing' }, { status: 503 });

          if (!tokensMatch(request.headers.get('authorization') ?? '', `Bearer ${triggerToken}`)) {
            return Response.json({ error: 'unauthorized' }, { status: 401 });
          }

          // Requiring JSON forces a CORS preflight, which gets 405, so a cross-origin page cannot post.
          if (!/^application\/json\s*(?:;|$)/iu.test(request.headers.get('content-type') ?? '')) {
            return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
          }

          const text = yield* readBoundedText(request, requestBodyLimitBytes);

          if (text === undefined) return Response.json({ error: 'too_large' }, { status: 413 });
          const parsed = parseTrigger(text);

          if (parsed === undefined)
            return Response.json({ error: 'invalid_json' }, { status: 400 });

          if (!parsed.ok) {
            return Response.json(
              { error: 'invalid_request', issues: parsed.error },
              { status: 400 },
            );
          }

          const { callback } = parsed.value;

          if (callback === undefined) {
            return Response.json({ error: 'missing_callback' }, { status: 400 });
          }

          return yield* accept({ ...parsed.value, callback });
        }),
      pending: () => inFlight.size,
      drain,
      close,
      receipts,
      shutdown,
    };
  });

/** Brackets a runner and exposes failed shutdown after a successful use through E. */
const withAgentRunner = <A, E, R>(
  options: AgentRunnerOptions,
  use: (runner: AgentRunner) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const runner = yield* createAgentRunner(options);

      return yield* withCleanup(
        Effect.gen(function* () {
          const result = yield* Effect.suspend(() => use(runner));
          yield* runner.drain();

          return result;
        }),
        runner.close(),
        undefined,
      );
    }),
  );

export {
  createAgentRunner,
  withAgentRunner,
  ClientCleanup,
  ClientCleanupError,
  AgentHandlerError,
  AgentRunnerError,
  RunnerIoError,
  type InvocationReceipt,
  type RunnerFetchError,
  type AgentHandler,
  type AgentInvocation,
  type AgentRunner,
  type AgentRunnerOptions,
  type HandlerContext,
  type HandlerOutcome,
  type HandlerResult,
  type RunnerFailure,
};
