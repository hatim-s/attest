import type { RawExcerpt } from '@attest/contracts';
import { createHash } from 'node:crypto';

const RAW_EXCERPT_CHARACTERS = 4096;
/** Enough payload bytes to fill a full excerpt even when every character takes four bytes. */
const RAW_EVIDENCE_PREFIX_BYTES = RAW_EXCERPT_CHARACTERS * 4;

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

/**
 * Keeps the payload prefix an excerpt can show while a transport streams an unbounded body, so a
 * capped response still yields evidence. Returns the new retained byte count.
 */
const appendEvidencePrefix = (
  chunks: Uint8Array[],
  retainedBytes: number,
  chunk: Uint8Array,
): number => {
  const retained = chunk.subarray(0, Math.max(0, RAW_EVIDENCE_PREFIX_BYTES - retainedBytes));
  if (retained.byteLength > 0) chunks.push(retained);
  return retainedBytes + retained.byteLength;
};

export { RAW_EXCERPT_CHARACTERS, appendEvidencePrefix, createRawExcerpt };
