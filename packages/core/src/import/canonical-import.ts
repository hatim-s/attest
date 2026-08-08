import { createHash } from 'node:crypto';

import type { TestCase } from '@attest/contracts';

type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Recursively canonicalizes JSON objects while retaining semantically ordered arrays. */
const canonicalizeJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left > right ? 1 : 0) - (left < right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalizeJson(entry)]),
  );
};

/** Serializes JSON independently from authored formatting or object insertion order. */
const serializeImportJson = (value: JsonValue): string => JSON.stringify(canonicalizeJson(value));

/** Computes the stable lowercase SHA-256 fingerprint used by import identities and dedupe. */
const hashImportJson = (value: JsonValue): string =>
  createHash('sha256').update(serializeImportJson(value), 'utf8').digest('hex');

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

const logicalIdContent = (testCase: Omit<TestCase, 'id'>): JsonValue =>
  ({
    input: testCase.input,
    ...(testCase.expected === undefined ? {} : { expected: testCase.expected }),
    ...(testCase.params === undefined ? {} : { params: testCase.params }),
  }) as JsonValue;

/** Generates the ratified move-stable id from input, expected, and params only. */
const createContentCaseId = (testCase: Omit<TestCase, 'id'>): string => {
  const digest = createHash('sha256')
    .update(serializeImportJson(logicalIdContent(testCase)))
    .digest();
  return `case-${encodeBase32(digest).slice(0, 16)}`;
};

/** Generates an opaque stable identity for an explicit incremental source key. */
const createKeyedCaseId = (sourceKey: JsonValue): string => {
  const digest = createHash('sha256')
    .update(serializeImportJson({ source_key: sourceKey }))
    .digest();
  return `case-${encodeBase32(digest).slice(0, 16)}`;
};

/** Fingerprints every normalized case field except its mutable stable id. */
const fingerprintCaseContent = ({ id: _id, ...testCase }: TestCase): string =>
  hashImportJson(testCase as JsonValue);

export {
  createContentCaseId,
  createKeyedCaseId,
  fingerprintCaseContent,
  hashImportJson,
  serializeImportJson,
  type JsonValue,
};
