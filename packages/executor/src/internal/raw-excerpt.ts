import type { RawExcerpt } from '@attest/contracts';
import { createHash } from 'node:crypto';

const RAW_EXCERPT_CHARACTERS = 4096;

/**
 * Retains deterministic, bounded payload evidence for an invocation attempt.
 * A hash accompanies truncated text so the complete captured payload remains
 * identifiable without retaining it in a run record.
 */
const createRawExcerpt = (payload: string): RawExcerpt => {
  const truncated = payload.length > RAW_EXCERPT_CHARACTERS;
  return {
    text: payload.slice(0, RAW_EXCERPT_CHARACTERS),
    truncated,
    ...(truncated ? { sha256: createHash('sha256').update(payload).digest('hex') } : {}),
  };
};

export { createRawExcerpt };
