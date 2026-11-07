import * as Effect from 'effect/Effect';
import type { HttpMetricDefinition } from '../metric-definitions.js';
import { abortReasonOf, composeAbortSignal } from './abort-signal.js';
import {
  abortedMetricError,
  type MetricTransportOptions,
  type MetricTransportOutcome,
} from './metric-transport.js';
import {
  foreign,
  ownOperation,
  withRelease,
  mustPropagateMetricCause,
  releaseAll,
} from './operation.js';

/** Posts once and owns the response reader until cancellation and release are observed. */
const invokeHttpMetric = (
  definition: HttpMetricDefinition,
  requestBody: string,
  options: MetricTransportOptions,
): Effect.Effect<MetricTransportOutcome, Error> =>
  ownOperation((cancelled) =>
    Effect.gen(function* () {
      if (!URL.canParse(definition.url))
        return {
          ok: false,
          error: {
            code: 'http_request_failed',
            message: `Metric HTTP URL must be a valid http:// or https:// URL; received "${definition.url}".`,
          },
        };
      const url = new URL(definition.url);

      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return {
          ok: false,
          error: {
            code: 'http_request_failed',
            message: `Metric HTTP URL must use http: or https:, not ${url.protocol}`,
          },
        };

      const signal = composeAbortSignal(
        AbortSignal.any([cancelled, ...(options.signal ? [options.signal] : [])]),
        options.timeoutMs,
      );

      return yield* Effect.gen(function* () {
        const response = yield* foreign(() =>
          fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: requestBody,
            signal,
          }),
        );

        if (response.body === null)
          return response.status === 200
            ? { ok: true as const, text: '' }
            : {
                ok: false as const,
                error: {
                  code: 'http_bad_status' as const,
                  message: `Metric HTTP endpoint returned ${response.status}, expected 200.`,
                  details: { status: response.status },
                },
              };
        const reader = response.body.getReader();
        let readFailed = false;
        void reader.closed.catch(() => {
          readFailed = true;
        });

        return yield* withRelease(
          Effect.gen(function* () {
            if (response.status !== 200)
              return {
                ok: false as const,
                error: {
                  code: 'http_bad_status' as const,
                  message: `Metric HTTP endpoint returned ${response.status}, expected 200.`,
                  details: { status: response.status },
                },
              };
            const chunks: Buffer[] = [];
            let received = 0;

            while (true) {
              const next = yield* foreign(() => reader.read()).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    readFailed = true;
                  }),
                ),
              );

              if (next.done) break;
              received += next.value.byteLength;

              if (received > options.outputCapBytes)
                return {
                  ok: false as const,
                  error: {
                    code: 'exec_malformed_output' as const,
                    message: `Metric HTTP response exceeded the ${options.outputCapBytes}-byte limit.`,
                  },
                };
              chunks.push(Buffer.from(next.value));
            }

            return { ok: true as const, text: Buffer.concat(chunks).toString() };
          }),
          releaseAll([
            // An errored stream has already released its source; cancel would only repeat the read error.
            Effect.suspend(() =>
              readFailed
                ? Effect.void
                : foreign(() =>
                    reader.cancel().catch((error) => {
                      if (!readFailed) throw error;
                    }),
                  ),
            ),
            Effect.sync(() => reader.releaseLock()),
          ]),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (mustPropagateMetricCause(cause)) return yield* Effect.failCause(cause);
            const error = yield* Effect.flip(Effect.failCause(cause));

            return {
              ok: false,
              error: signal.aborted
                ? abortedMetricError(abortReasonOf(signal), options.timeoutMs)
                : {
                    code: 'http_request_failed',
                    message: `Could not call metric HTTP endpoint: ${error.message}`,
                  },
            } satisfies MetricTransportOutcome;
          }),
        ),
      );
    }),
  );

export { invokeHttpMetric };
