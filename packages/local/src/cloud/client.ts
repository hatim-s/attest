import { parseWithSchemaEffect, type JsonValue } from '@attest/contracts';
import { redactTransportText } from '@attest/executor';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import type { CloudCredentialSource } from './credentials.js';
import { LocalError } from '../errors/local-error.js';
import { withOperationCleanup, OperationCleanup } from '../internal/operation-cleanup.js';
import { CloudRemoteError, decodeRemoteError } from './protocol.js';

type CloudClient = {
  readonly baseUrl: string;
  readonly credentialSource?: CloudCredentialSource;
  upload: <T>(
    path: string,
    options: { schema: Schema.ConstraintDecoder<T>; body: string; signal?: AbortSignal },
  ) => Effect.Effect<T, LocalError>;
  request: <T>(
    method: string,
    path: string,
    options: { schema: Schema.ConstraintDecoder<T>; body?: JsonValue; signal?: AbortSignal },
  ) => Effect.Effect<T, LocalError>;
};

type CloudClientOptions = {
  baseUrl: string;
  accessToken?: string;
  credentialSource?: CloudCredentialSource;
  fetch?: typeof fetch;
};

/** Accepts encrypted endpoints and loopback development origins without credentials. */
const normalizeCloudUrl = (value: string): string => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new LocalError('cli_usage', 'Cloud URL must be an absolute HTTPS URL.');
  }

  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new LocalError(
      'cli_usage',
      'Cloud URL must be an HTTPS origin, or an HTTP loopback origin.',
    );

  return url.origin;
};

/** Bounds response bytes and retains release failures rather than replacing primary failures. */
const readResponseText = Effect.fn('readCloudResponse')(function* (response: Response) {
  const limit = 16 * 1024 * 1024;

  const invalid = () =>
    new LocalError('cloud_request_failed', 'Cloud response exceeds the supported size.');

  const reader = response.body?.getReader();

  if (!reader)
    return yield* Effect.fail(new LocalError('cloud_request_failed', 'Cloud response is empty.'));
  let done = false;

  return yield* withOperationCleanup(
    Effect.gen(function* () {
      if (Number(response.headers.get('content-length')) > limit)
        return yield* Effect.fail(invalid());
      const chunks: Uint8Array[] = [];
      let size = 0;

      for (;;) {
        const chunk = yield* Effect.tryPromise({
          try: () => reader.read(),
          catch: () => new LocalError('cloud_request_failed', 'Cloud response did not complete.'),
        });

        if (chunk.done) {
          done = true;
          break;
        }

        size += chunk.value.byteLength;

        if (size > limit) return yield* Effect.fail(invalid());
        chunks.push(chunk.value);
      }

      const bytes = new Uint8Array(size);
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return new TextDecoder().decode(bytes);
    }),
    withOperationCleanup(
      Effect.suspend(() =>
        done
          ? Effect.void
          : Effect.timeoutOption(
              Effect.interruptible(
                Effect.tryPromise({
                  try: () => reader.cancel(),
                  catch: (cause) =>
                    new LocalError('cloud_request_failed', 'Cloud response cancellation failed.', {
                      cause,
                    }),
                }),
              ),
              1000,
            ).pipe(
              Effect.flatMap((result) =>
                Option.isSome(result)
                  ? Effect.void
                  : Effect.fail(
                      new LocalError(
                        'cloud_request_failed',
                        'Cloud response cleanup is unconfirmed.',
                      ),
                    ),
              ),
            ),
      ),
      Effect.sync(() => reader.releaseLock()),
    ),
  );
});

/** Sends each request once. Unknown dispatch is never retried or treated as rollback. */
const createCloudClient = (options: CloudClientOptions): CloudClient => {
  const baseUrl = normalizeCloudUrl(options.baseUrl);
  const fetcher = options.fetch ?? fetch;

  const send = Effect.fn('sendCloudRequest')(function* <T>(
    method: string,
    path: string,
    request: {
      schema: Schema.ConstraintDecoder<T>;
      body?: string;
      signal?: AbortSignal;
      contentType: string;
      timeout: number;
    },
  ) {
    if (
      !path.startsWith('/v1/') ||
      path.startsWith('//') ||
      new URL(path, baseUrl).origin !== baseUrl ||
      !new URL(path, baseUrl).pathname.startsWith('/v1/')
    )
      return yield* Effect.fail(
        new LocalError('cli_usage', 'Cloud request path must stay under /v1/.'),
      );
    const headers = new Headers({ accept: 'application/json' });

    if (request.body !== undefined) headers.set('content-type', request.contentType);

    if (options.accessToken !== undefined)
      headers.set('authorization', `Bearer ${options.accessToken}`);

    if (request.signal?.aborted)
      return yield* Effect.fail(new LocalError('cancelled', 'Cloud request did not complete.'));
    const controller = new AbortController();
    const cancel = () => controller.abort(request.signal?.reason);
    const timer = setTimeout(() => controller.abort(), request.timeout);

    return yield* withOperationCleanup(
      Effect.gen(function* () {
        request.signal?.addEventListener('abort', cancel, { once: true });

        // The request owner supplies cancellation to the foreign fetch. No racing or replay follows an unknown outcome.
        const response = yield* Effect.tryPromise({
          try: () =>
            fetcher(new URL(path, baseUrl), {
              method,
              redirect: 'error',
              signal: controller.signal,
              headers,
              body: request.body,
            }),
          catch: (cause) =>
            new LocalError(
              request.signal?.aborted ? 'cancelled' : 'cloud_unavailable',
              'Cloud request did not complete.',
              { cause },
            ),
        });

        if (!response.ok) {
          const observed = yield* Effect.exit(
            readResponseText(response).pipe(
              Effect.flatMap((text) =>
                Effect.try({
                  // BOUNDARY: HTTP JSON is decoded by the endpoint or remote error schema below.
                  try: () => {
                    const value: unknown = JSON.parse(text);

                    return value;
                  },
                  catch: () => new LocalError('cloud_request_failed', 'Invalid JSON'),
                }),
              ),
            ),
          );

          if (
            Exit.isFailure(observed) &&
            (Cause.hasDies(observed.cause) || Cause.hasInterrupts(observed.cause))
          )
            return yield* Effect.failCause(observed.cause);
          const value = Exit.isSuccess(observed) ? observed.value : undefined;

          const outcome = decodeRemoteError(value);

          if (outcome.kind === 'known')
            outcome.message = redactTransportText(
              outcome.message,
              options.accessToken === undefined ? [] : [options.accessToken],
            );

          const primary = Cause.fail(new CloudRemoteError(response.status, outcome));

          return yield* Effect.failCause(
            Exit.isFailure(observed)
              ? Cause.annotate(primary, Context.make(OperationCleanup, observed.cause))
              : primary,
          );
        }

        const value =
          response.status === 204
            ? undefined
            : yield* readResponseText(response).pipe(
                Effect.flatMap((text) =>
                  Effect.try({
                    // BOUNDARY: HTTP JSON is decoded by the endpoint or remote error schema below.
                    try: () => {
                      const value: unknown = JSON.parse(text);

                      return value;
                    },
                    catch: () =>
                      new LocalError(
                        'cloud_request_failed',
                        'Cloud returned an invalid JSON response.',
                      ),
                  }),
                ),
              );

        return yield* parseWithSchemaEffect(request.schema, value).pipe(
          Effect.mapError(
            (cause) =>
              new LocalError(
                'cloud_request_failed',
                'Cloud returned a response that does not match the protocol.',
                { cause },
              ),
          ),
        );
      }),
      Effect.sync(() => {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', cancel);
      }),
    );
  }, Effect.uninterruptible);

  return {
    baseUrl,
    credentialSource: options.credentialSource,
    request: (method, path, request) =>
      send(method, path, {
        ...request,
        contentType: 'application/json',
        timeout: 30_000,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      }),
    upload: (path, request) =>
      send('POST', path, { ...request, contentType: 'application/x-ndjson', timeout: 120_000 }),
  };
};

export { createCloudClient, normalizeCloudUrl, type CloudClient, type CloudClientOptions };
