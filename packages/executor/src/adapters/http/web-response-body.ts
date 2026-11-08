import * as Effect from 'effect/Effect';
import { createHash } from 'node:crypto';
import { AgentInvocationError, abortedError } from '../../errors.js';
import { parseJson } from '../../internal/json-value.js';
import { appendEvidencePrefix, createRawExcerpt } from '../../internal/raw-excerpt.js';
import { awaitAbort, withHttpCleanup } from './http-effects.js';
import { redactTransportText } from './redaction.js';
import type { HttpClientPolicy } from './http-client.js';

/** Reads foreign body chunks one at a time, preserving capped evidence before closing the reader. */
const readWebJson = Effect.fn('http.webJson')(function* (
  response: Response,
  policy: HttpClientPolicy,
) {
  const reader = response.body?.getReader();

  const chunks: Uint8Array[] = [];
  const evidence: Uint8Array[] = [];
  const hash = createHash('sha256');
  let bytes = 0;
  let evidenceBytes = 0;

  const primary = Effect.gen(function* () {
    while (reader !== undefined) {
      if (policy.attemptSignal.aborted)
        return yield* Effect.fail(abortedError(policy.callerSignal, 'HTTP request'));

      const next = Effect.tryPromise({
        try: () => reader.read(),
        catch: (cause) =>
          new AgentInvocationError('network', 'HTTP response body failed.', { cause }),
      });

      const item = yield* Effect.raceFirst(
        next.pipe(
          Effect.timeoutOrElse({
            duration: policy.responseBodyTimeoutMs,
            orElse: () =>
              Effect.fail(new AgentInvocationError('timeout', 'HTTP response body timed out.')),
          }),
        ),
        awaitAbort(policy.attemptSignal).pipe(
          Effect.andThen(() => Effect.fail(abortedError(policy.callerSignal, 'HTTP request'))),
        ),
      );

      if (item.done) break;
      bytes += item.value.byteLength;
      hash.update(item.value);
      evidenceBytes = appendEvidencePrefix(evidence, evidenceBytes, item.value);

      if (bytes > policy.responseCapBytes)
        return yield* Effect.fail(
          new AgentInvocationError(
            'output_cap_exceeded',
            `HTTP agent response exceeds the ${policy.responseCapBytes}-byte output cap.`,
            {
              rawExcerpt: {
                ...createRawExcerpt(
                  redactTransportText(
                    Buffer.concat(evidence, evidenceBytes).toString('utf8'),
                    policy.secrets,
                  ),
                ),
                truncated: true,
                sha256: hash.digest('hex'),
              },
            },
          ),
        );
      chunks.push(item.value);
    }

    const payload = Buffer.concat(chunks, bytes).toString('utf8');
    const rawExcerpt = createRawExcerpt(redactTransportText(payload, policy.secrets));

    if (response.status < 200 || response.status >= 300) return { raw: null, rawExcerpt };

    const raw = yield* Effect.try({
      try: () => parseJson(payload),
      catch: (cause) =>
        new AgentInvocationError(
          'invalid_envelope',
          'HTTP agent response body is not valid JSON.',
          { cause, rawExcerpt },
        ),
    });

    return { raw, rawExcerpt };
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
    reader === undefined
      ? []
      : [
          Effect.tryPromise({
            try: () => reader.cancel(),
            catch: (cause) =>
              new AgentInvocationError('network', 'HTTP response body cancel failed.', { cause }),
          }).pipe(Effect.interruptible, Effect.timeout(100)),
          Effect.sync(() => reader.releaseLock()),
        ],
  );
});

export { readWebJson };
