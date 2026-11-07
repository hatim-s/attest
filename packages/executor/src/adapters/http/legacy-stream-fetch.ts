import * as Effect from 'effect/Effect';
import { openGuardedResponse } from './guarded-response.js';
import type { GuardedHttpFetch } from './guarded-response.js';
import type { MaterializedHttpRequest } from './request-template.js';
import type { StreamHttpResponse } from '../stream/stream-transport.js';

/** Opens headers with a bounded deadline and transfers cancellation to the returned body. */
const openFetchResponse = async (
  guardedFetch: GuardedHttpFetch,
  request: MaterializedHttpRequest,
  signal: AbortSignal,
  firstByteMs: number,
): Promise<StreamHttpResponse> => {
  // EFFECT-BRIDGE(S4a): Promise stream owner acquires native fetch headers; S4a removes this root.
  const { response, controller, release } = await Effect.runPromise(
    openGuardedResponse(guardedFetch, request, signal, firstByteMs).pipe(
      Effect.catch((error) => (signal.aborted ? Effect.fail(signal.reason) : Effect.fail(error))),
    ),
  );

  const reader = response.body?.getReader();
  let cancelled = false;

  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    release();
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  };

  const body = (async function* (): AsyncGenerator<Uint8Array> {
    try {
      if (reader === undefined) return;

      for (;;) {
        const next = await reader.read();

        if (next.done) return;
        yield next.value;
      }
    } finally {
      cancel();
      reader?.releaseLock();
    }
  })();

  return { status: response.status, headers: Object.fromEntries(response.headers), body, cancel };
};

export { openFetchResponse };
