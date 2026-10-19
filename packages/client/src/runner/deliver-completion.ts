import type { AgentCallback } from '@attest/contracts';

// Three attempts: at once, then after 250 ms, then after 1 s.
const RETRY_DELAYS_MS = [0, 250, 1_000] as const;

const ATTEMPT_TIMEOUT_MS = 30_000;

type DeliveryOutcome = { delivered: true } | { delivered: false; reason: string };

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Posts a serialized completion to the callback URL with its bearer token. Network errors and 5xx
 * answers are retried; any other non-2xx answer is final because the receiver has already judged
 * the completion (401 bad token, 409 duplicate, 413 too large).
 */
const deliverCompletion = async (
  fetchImpl: typeof fetch,
  callback: AgentCallback,
  body: string,
): Promise<DeliveryOutcome> => {
  let reason = '';

  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay);

    try {
      const response = await fetchImpl(callback.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${callback.token}`,
          'content-type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });

      await response.body?.cancel();

      if (response.ok) return { delivered: true };
      reason = `receiver answered ${String(response.status)}`;

      if (response.status < 500) return { delivered: false, reason };
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }

  return { delivered: false, reason };
};

export { deliverCompletion };
