import { createHash } from 'node:crypto';

import type { AgentResource } from '@attest/contracts';

type RetryBackoff = NonNullable<AgentResource['retry']>['backoff'];

/**
 * Computes the authored delay before retry `retryIndex`. Exponential jitter is derived from the
 * authored seed so reruns wait the same amounts while concurrent callers still spread out.
 */
const retryBackoffDelay = (backoff: RetryBackoff | undefined, retryIndex: number): number => {
  if (backoff === undefined || backoff.kind === 'none') return 0;
  if (backoff.kind === 'fixed') return backoff.delay_ms;
  const bounded = Math.min(backoff.initial_delay_ms * 2 ** retryIndex, backoff.maximum_delay_ms);
  const jitter = createHash('sha256')
    .update(`${String(backoff.jitter_seed)}:${String(retryIndex)}`)
    .digest()
    .readUInt32BE(0);
  return Math.floor((bounded * (75 + (jitter % 51))) / 100);
};

export { retryBackoffDelay };
