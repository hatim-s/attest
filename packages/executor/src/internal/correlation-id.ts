import { createHash } from 'node:crypto';

import type { AgentRequest } from '@attest/contracts';

/**
 * Derives a bounded, per-session unique request id. Case ids are authored and unbounded, so the
 * wire id carries only a digest of the run and case plus the session sequence number.
 */
const correlationId = (prefix: string, request: AgentRequest, sequence: number): string => {
  const digest = createHash('sha256')
    .update(request.run_id)
    .update('\0')
    .update(request.case_id)
    .digest('hex')
    .slice(0, 32);
  return `${prefix}-${sequence.toString(36)}-${digest}`;
};

export { correlationId };
