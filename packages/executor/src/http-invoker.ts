import * as Effect from 'effect/Effect';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import { readWebJson } from './adapters/http/web-response-body.js';
import { openGuardedResponse } from './adapters/http/guarded-response.js';
import { withHttpSignal, withHttpCleanup } from './adapters/http/http-effects.js';
import type { AgentRequest } from '@attest/contracts';

import { AgentInvocationError, abortedError } from './errors.js';
import { startTimer } from './internal/elapsed.js';
import { createFailedAttempt } from './internal/failed-attempt.js';
import { invokeWithRetries } from './internal/invocation-retry.js';
import type {
  InvocationAttempt,
  InvocationResult,
  InvokeOptions,
  NativeAgentTarget,
} from './types.js';

/**
 * Invokes an HTTP agent once so the runner can apply the contract's retry policy separately.
 *
 * The HTTP transport and execution-semantics sections of docs/specs/agent-contract.md require
 * infrastructure failures to remain distinct from agent response-envelope semantics downstream.
 * Redirects are deliberately not followed: every 3xx is a terminal `http_status` error and is
 * never retried, preventing request envelopes from being forwarded to an unconfigured endpoint.
 */
const invokeHttpAgent = Effect.fn('http.invokeAttempt')(function* (
  target: Extract<NativeAgentTarget, { type: 'http' }>,
  request: AgentRequest,
  options: InvokeOptions,
): Effect.fn.Return<InvocationAttempt, AgentInvocationError> {
  const duration = startTimer();

  return yield* withHttpSignal(options.timeoutMs, [options.signal], (signal) =>
    Effect.gen(function* () {
      let httpStatus: number | undefined;

      const operation = Effect.gen(function* () {
        const opened = yield* openGuardedResponse(
          options.httpFetch ?? fetch,
          {
            url: target.url,
            method: 'POST',
            headers: { 'content-type': 'application/json', ...options.httpHeaders },
            body: JSON.stringify(request),
          },
          signal,
          options.timeoutMs,
        ).pipe(
          Effect.mapError((error) =>
            signal.aborted
              ? abortedError(options.signal, 'HTTP agent invocation', {
                  cause: error,
                  applicationStarted: error.applicationStarted,
                })
              : error,
          ),
        );

        const { response } = opened;

        return yield* withHttpCleanup(
          Effect.gen(function* () {
            httpStatus = response.status;

            if (response.status !== 200) {
              // Status is authoritative at header receipt; body size and read failures cannot reclassify it.
              const cancellation = yield* Effect.exit(
                Effect.tryPromise({
                  try: () => response.body?.cancel() ?? Promise.resolve(),
                  catch: (cause) =>
                    new AgentInvocationError('network', 'HTTP response body cancel failed.', {
                      cause,
                    }),
                }).pipe(Effect.interruptible, Effect.timeoutOption(100)),
              );

              // An errored stream rejects cancel with its stored error but is already closed.
              // A missing acknowledgement or interrupted release still prohibits another request.
              const unconfirmed = Exit.isSuccess(cancellation)
                ? Option.isNone(cancellation.value)
                : Cause.hasInterrupts(cancellation.cause) || Cause.hasDies(cancellation.cause);

              return yield* Effect.fail(
                new AgentInvocationError(
                  'http_status',
                  `HTTP agent returned status ${response.status}.`,
                  { applicationStarted: unconfirmed, cause: { bodyCancellation: cancellation } },
                ),
              );
            }

            const parsed = yield* readWebJson(response, {
              attemptSignal: signal,
              callerSignal: options.signal,
              connectTimeoutMs: options.timeoutMs,
              firstByteTimeoutMs: options.timeoutMs,
              responseBodyTimeoutMs: options.timeoutMs,
              responseCapBytes: options.outputCapBytes,
              secrets: [],
            });

            return {
              status: 'ok' as const,
              raw: parsed.raw,
              diagnostics: { httpStatus: response.status },
              durationMs: duration(),
              rawExcerpt: parsed.rawExcerpt,
              warnings: [],
            };
          }),
          [Effect.sync(opened.release)],
        );
      });

      return yield* operation.pipe(
        Effect.catch((error) =>
          Effect.succeed(
            createFailedAttempt(error, {
              diagnostics: httpStatus === undefined ? {} : { httpStatus },
              durationMs: duration(),
              rawExcerpt: error.rawExcerpt,
            }),
          ),
        ),
      );
    }),
  );
});

/** Invokes and validates one native HTTP request without retrying interrupted remote work. */
const invokeNativeHttpAgent = (
  target: Extract<NativeAgentTarget, { type: 'http' }>,
  request: AgentRequest,
  options: InvokeOptions,
): Effect.Effect<InvocationResult, AgentInvocationError> =>
  invokeWithRetries(() => invokeHttpAgent(target, request, options), 0);

export { invokeHttpAgent, invokeNativeHttpAgent };
