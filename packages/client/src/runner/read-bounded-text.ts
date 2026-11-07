import { Cause, Effect, Exit } from 'effect';
import { withCleanup } from './lifetime.js';

/** Reads capped UTF-8 input and always cancels and releases the reader. */
const readBoundedText = (request: Request, maxBytes: number) =>
  Effect.gen(function* () {
    if (Number(request.headers.get('content-length') ?? 0) > maxBytes) return undefined;

    if (request.body === null) return '';
    const reader = request.body.getReader();

    return yield* withCleanup(
      Effect.gen(function* () {
        const chunks: Uint8Array[] = [];
        let size = 0;

        for (;;) {
          const { done, value } = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: (cause) => new Error('Request body failed.', { cause }),
          }).pipe(Effect.timeout(10_000));

          if (done) break;
          size += value.byteLength;

          if (size > maxBytes) return undefined;
          chunks.push(value);
        }

        const bytes = new Uint8Array(size);
        let offset = 0;

        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }

        return new TextDecoder().decode(bytes);
      }).pipe(Effect.timeout(10_000)),
      Effect.gen(function* () {
        const cancelled = yield* Effect.exit(
          Effect.tryPromise({ try: () => reader.cancel(), catch: (cause) => cause }).pipe(
            Effect.timeout(1_000),
          ),
        );

        const released = yield* Effect.exit(Effect.sync(() => reader.releaseLock()));

        if (Exit.isFailure(cancelled) && Exit.isFailure(released))
          return yield* Effect.failCause(Cause.combine(cancelled.cause, released.cause));
        yield* cancelled;
        yield* released;
      }),
      3_000,
    );
  });

export { readBoundedText };
