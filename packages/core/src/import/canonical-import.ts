import { createHash } from 'node:crypto';

import type { JsonValue, TestCase } from '@attest/contracts';

import { canonicalStringify, contentHash } from '../store/internal/canonical-json.js';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Encodes digest bytes with unpadded lowercase RFC 4648 base32. */
const encodeBase32 = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let encoded = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) encoded += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return encoded;
};

const caseIdFromDigest = (identity: unknown): string => {
  const digest = createHash('sha256').update(canonicalStringify(identity)).digest();
  return `case-${encodeBase32(digest).slice(0, 16)}`;
};

/**
 * Derives a case id from input, expected, and params only, so moving a case between folders or
 * retagging it keeps its id. Canonical JSON drops the undefined optional fields.
 */
const createContentCaseId = ({ input, expected, params }: Omit<TestCase, 'id'>): string =>
  caseIdFromDigest({ input, expected, params });

/** Derives an opaque case id from an explicit source key, so edited rows keep their identity. */
const createKeyedCaseId = (sourceKey: JsonValue): string =>
  caseIdFromDigest({ source_key: sourceKey });

/** Fingerprints every case field except the id, which an update may preserve from the target. */
const fingerprintCaseContent = (testCase: TestCase): string =>
  contentHash({ ...testCase, id: undefined });

export { createContentCaseId, createKeyedCaseId, fingerprintCaseContent };
