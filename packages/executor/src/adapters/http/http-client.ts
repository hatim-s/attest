import * as Effect from 'effect/Effect';
import { httpSync, awaitAbort, withHttpCleanup } from './http-effects.js';
import { parseJson } from '../../internal/json-value.js';
import type { JsonValue } from '@attest/contracts';
import { createHash } from 'node:crypto';

import type { IncomingMessage } from 'node:http';

import type { RawExcerpt } from '@attest/contracts';

import { AgentInvocationError, abortedError } from '../../errors.js';
import { appendEvidencePrefix, createRawExcerpt } from '../../internal/raw-excerpt.js';
import { openPinnedRequest } from './pinned-request.js';
import type { MaterializedHttpRequest } from './request-template.js';
import { redactTransportText } from './redaction.js';
import { requireSameOrigin } from './same-origin.js';
import { resolveSafeHttpUrl } from './url-security.js';

type HttpClientPolicy = {
  attemptSignal: AbortSignal;
  callerSignal?: AbortSignal;
  connectTimeoutMs: number;
  firstByteTimeoutMs: number;
  responseBodyTimeoutMs: number;
  responseCapBytes: number;
  secrets: readonly string[];
};

/** One bounded response whose body is kept as bytes for callers that do not expect JSON. */
type HttpResponse = {
  body: Buffer;
  headers: Record<string, string>;
  rawExcerpt: RawExcerpt;
  status: number;
  url: URL;
};

type HttpJsonResponse = Omit<HttpResponse, 'body'> & { raw: JsonValue };

/** A host-supplied transport must enforce endpoint security and the supplied limits. */
type HttpJsonTransport = (
  request: MaterializedHttpRequest,
  policy: HttpClientPolicy,
) => Effect.Effect<HttpJsonResponse, AgentInvocationError>;

const MAX_REDIRECTS = 3;

const abortError = (policy: HttpClientPolicy): AgentInvocationError =>
  abortedError(policy.callerSignal, 'Mapped HTTP request');

const normalizeHeaders = (headers: NodeJS.Dict<string | string[]>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers)
      .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
      .map(([name, value]) => [
        name.toLowerCase(),
        Array.isArray(value) ? value.join(', ') : value,
      ]),
  );

const isSuccessStatus = (status: number): boolean => status >= 200 && status < 300;

/** Reads one response body while enforcing cancellation, idle, and aggregate byte caps. */
const readResponseBody = Effect.fn('http.readBody')(function* (
  response: IncomingMessage,
  policy: HttpClientPolicy,
): Effect.fn.Return<{ body: Buffer; rawExcerpt: RawExcerpt }, AgentInvocationError> {
  const chunks: Buffer[] = [];
  const evidence: Uint8Array[] = [];
  let byteCount = 0;
  let evidenceBytes = 0;
  // IncomingMessage yields Buffer chunks when no encoding is installed.
  const iterator = response[Symbol.asyncIterator]();

  const primary = Effect.gen(function* () {
    for (;;) {
      if (policy.attemptSignal.aborted) return yield* Effect.fail(abortError(policy));

      const next = Effect.tryPromise({
        try: () => iterator.next(),
        catch: (cause) =>
          new AgentInvocationError('network', 'Mapped HTTP response body failed.', { cause }),
      });

      const item = yield* Effect.raceFirst(
        next.pipe(
          Effect.timeoutOrElse({
            duration: policy.responseBodyTimeoutMs,
            orElse: () =>
              Effect.fail(
                new AgentInvocationError('timeout', 'Mapped HTTP response body timed out.'),
              ),
          }),
        ),
        awaitAbort(policy.attemptSignal).pipe(
          Effect.andThen(() => Effect.fail(abortError(policy))),
        ),
      );

      if (item.done) break;
      // Node's binary IncomingMessage iterator returns Buffer when no encoding is set.
      const chunk: unknown = item.value;

      if (!Buffer.isBuffer(chunk))
        return yield* Effect.die(new Error('Binary HTTP response yielded a non-Buffer chunk.'));
      byteCount += chunk.byteLength;
      evidenceBytes = appendEvidencePrefix(evidence, evidenceBytes, chunk);

      if (byteCount > policy.responseCapBytes) {
        const prefix = Buffer.concat(evidence, evidenceBytes).toString('utf8');

        return yield* Effect.fail(
          new AgentInvocationError(
            'output_cap_exceeded',
            `Mapped HTTP response exceeds the ${policy.responseCapBytes}-byte response cap.`,
            {
              rawExcerpt: {
                ...createRawExcerpt(redactTransportText(prefix, policy.secrets)),
                truncated: true,
                sha256: createHash('sha256')
                  .update(Buffer.concat([...chunks, chunk]))
                  .digest('hex'),
              },
            },
          ),
        );
      }

      chunks.push(chunk);
    }

    const body = Buffer.concat(chunks, byteCount);

    return {
      body,
      rawExcerpt: createRawExcerpt(redactTransportText(body.toString('utf8'), policy.secrets)),
    };
  });

  return yield* withHttpCleanup(
    primary.pipe(
      Effect.mapError(
        (error) =>
          new AgentInvocationError(error.code, error.message, {
            ...error,
            cause: error.cause,
            applicationStarted: true,
          }),
      ),
    ),
    [
      Effect.callback<void>((resume) => {
        if (response.closed) {
          resume(Effect.void);

          return;
        }

        const closed = (): void => resume(Effect.void);
        response.once('close', closed);
        response.destroy();

        return Effect.sync(() => response.removeListener('close', closed));
      }).pipe(Effect.interruptible, Effect.timeout(100)),
    ],
  );
});

/** Performs one DNS-pinned request and returns its bounded body. */
const requestOnce = Effect.fn('http.requestOnce')(function* (
  request: MaterializedHttpRequest,
  policy: HttpClientPolicy,
): Effect.fn.Return<HttpResponse, AgentInvocationError> {
  if (policy.attemptSignal.aborted) return yield* Effect.fail(abortError(policy));

  const resolved = yield* resolveSafeHttpUrl(request.url, {
    timeoutMs: policy.connectTimeoutMs,
    signal: policy.attemptSignal,
    callerSignal: policy.callerSignal,
  });

  if (policy.secrets.length > 0 && resolved.url.protocol !== 'https:' && !resolved.loopback) {
    return yield* Effect.fail(
      new AgentInvocationError(
        'network',
        'Mapped HTTP secrets require HTTPS except for explicit loopback endpoints.',
      ),
    );
  }

  const opened = yield* openPinnedRequest(resolved, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: policy.attemptSignal,
    firstByteTimeoutMs: policy.firstByteTimeoutMs,
    connectTimeoutMs: policy.connectTimeoutMs,
    errors: {
      aborted: () => abortError(policy),
      firstByteTimeout: () =>
        new AgentInvocationError('timeout', 'Mapped HTTP first byte timed out.'),
      connectTimeout: () =>
        new AgentInvocationError('timeout', 'Mapped HTTP connection timed out.'),
      failed: (cause) =>
        new AgentInvocationError('network', 'Mapped HTTP transport failed.', { cause }),
    },
  });

  const { response } = opened;
  const { body, rawExcerpt } = yield* readResponseBody(response, policy);

  return {
    body,
    headers: normalizeHeaders(response.headers),
    rawExcerpt,
    status: response.statusCode ?? 0,
    url: resolved.url,
  };
});

/** Follows only bounded, method-preserving, same-origin redirects and returns the body bytes. */
const requestHttp = Effect.fn('http.request')(function* (
  request: MaterializedHttpRequest,
  policy: HttpClientPolicy,
): Effect.fn.Return<HttpResponse, AgentInvocationError> {
  const origin = new URL(request.url);
  let current = request;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = yield* requestOnce(current, policy);

    if (![307, 308].includes(response.status)) return response;
    const location = response.headers.location;

    if (location === undefined || redirects === MAX_REDIRECTS) {
      return yield* Effect.fail(
        new AgentInvocationError('http_status', `Mapped HTTP returned status ${response.status}.`, {
          httpStatus: response.status,
          rawExcerpt: response.rawExcerpt,
        }),
      );
    }

    const redirected = new URL(location, response.url);
    yield* httpSync(() => requireSameOrigin(redirected, origin));
    current = { ...current, url: redirected.toString() };
  }

  return yield* Effect.fail(
    new AgentInvocationError('http_status', 'Mapped HTTP redirect limit was exceeded.'),
  );
});

/** Sends one request like requestHttp. Only a success body is parsed as JSON; others stay evidence. */
const requestJson: HttpJsonTransport = Effect.fn('http.requestJson')(function* (request, policy) {
  const { body, ...response } = yield* requestHttp(request, policy);

  if (!isSuccessStatus(response.status)) return { ...response, raw: null };

  return {
    ...response,
    raw: yield* Effect.try({
      try: () => parseJson(body.toString('utf8')),
      catch: (cause) =>
        new AgentInvocationError('invalid_envelope', 'Mapped HTTP response is not valid JSON.', {
          cause,
          rawExcerpt: response.rawExcerpt,
        }),
    }),
  };
});

export {
  requestHttp,
  requestJson,
  type HttpClientPolicy,
  type HttpJsonResponse,
  type HttpJsonTransport,
  type HttpResponse,
};
