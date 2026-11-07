import * as Effect from 'effect/Effect';
import { AgentInvocationError, abortedError } from '../../errors.js';
import { DEFAULT_FIRST_BYTE_MS } from '../../internal/agent-defaults.js';
import type { StreamHttpTransport } from '../stream/stream-transport.js';
import type { HttpJsonTransport } from './http-client.js';
import { httpSync, withHttpCleanup } from './http-effects.js';
import { openGuardedResponse, type GuardedHttpFetch } from './guarded-response.js';
import { openFetchResponse } from './legacy-stream-fetch.js';
import { readWebJson } from './web-response-body.js';
import { requireSameOrigin } from './same-origin.js';

/** Adapts guarded host fetch. The host owns DNS pinning and connect deadlines. */
const createFetchHttpTransports = (guardedFetch: GuardedHttpFetch) => {
  const requestJson: HttpJsonTransport = Effect.fn('http.guardedJson')(function* (request, policy) {
    const origin = new URL(request.url);
    let current = request;

    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (policy.attemptSignal.aborted)
        return yield* Effect.fail(abortedError(policy.callerSignal, 'Mapped HTTP request'));

      const opened = yield* openGuardedResponse(
        guardedFetch,
        current,
        policy.attemptSignal,
        policy.firstByteTimeoutMs,
      ).pipe(
        Effect.mapError((error) =>
          policy.attemptSignal.aborted
            ? abortedError(policy.callerSignal, 'Mapped HTTP request', {
                cause: error,
                applicationStarted: error.applicationStarted,
              })
            : error,
        ),
      );

      const parsed = yield* withHttpCleanup(readWebJson(opened.response, policy), [
        Effect.sync(opened.release),
      ]);

      const result = {
        ...parsed,
        status: opened.response.status,
        headers: Object.fromEntries(opened.response.headers),
        url: new URL(current.url),
      };

      if (![307, 308].includes(result.status)) return result;
      const location = result.headers.location;

      if (location === undefined || redirects === 3)
        return yield* Effect.fail(
          new AgentInvocationError('http_status', `Mapped HTTP returned status ${result.status}.`, {
            httpStatus: result.status,
            rawExcerpt: result.rawExcerpt,
          }),
        );
      const redirected = new URL(location, result.url);
      yield* httpSync(() => requireSameOrigin(redirected, origin));
      current = { ...current, url: redirected.toString() };
    }

    return yield* Effect.fail(
      new AgentInvocationError('http_status', 'Mapped HTTP redirect limit was exceeded.'),
    );
  });

  const requestStream: StreamHttpTransport = (agent, request, signal) =>
    openFetchResponse(
      guardedFetch,
      request,
      signal,
      agent.timeouts?.first_byte_ms ?? DEFAULT_FIRST_BYTE_MS,
    );

  return { requestJson, requestStream };
};

export { createFetchHttpTransports, type GuardedHttpFetch };
