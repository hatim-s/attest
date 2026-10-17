import { isJsonObject, type JsonValue } from '@attest/contracts';

import { readJsonPointer, splitJsonPointer } from './json-pointer.js';

const REDACTED = '[REDACTED]';

/** Normalizes escape digits while preserving case-sensitive credential characters. */
const lowercasePercentEscapes = (value: string): string =>
  value.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase());

/** Enumerates common transport encodings so reflected credentials cannot evade evidence redaction. */
const secretRepresentations = (secret: string): string[] => {
  if (secret.length === 0) return [];
  const jsonEscaped = JSON.stringify(secret).slice(1, -1);
  const percentEncoded = encodeURIComponent(secret);
  const formEncoded = new URLSearchParams({ value: secret }).toString().slice('value='.length);
  const bytes = Buffer.from(secret, 'utf8');

  return [
    secret,
    jsonEscaped,
    percentEncoded,
    lowercasePercentEscapes(percentEncoded),
    formEncoded,
    lowercasePercentEscapes(formEncoded),
    bytes.toString('base64'),
    bytes.toString('base64url'),
    bytes.toString('hex'),
  ]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
};

/** Redacts literal, escaped, percent/form encoded, and common byte encodings of runtime secrets. */
const redactTransportText = (value: string, secrets: readonly string[]): string =>
  [...new Set(secrets.flatMap(secretRepresentations))]
    // Replace longer credentials first so a shared prefix cannot expose their remaining bytes.
    .sort((left, right) => right.length - left.length)
    .reduce((redacted, secret) => redacted.replaceAll(secret, REDACTED), value);

/** Replaces the values that authored pointers reach in one event, then redacts runtime secrets. */
const redactEventEvidence = (
  value: JsonValue,
  pointers: readonly string[],
  secrets: readonly string[],
): string => {
  const redacted = structuredClone(value);

  for (const pointer of pointers) {
    const leaf = splitJsonPointer(pointer).pop();

    // The root pointer names the whole event, so the entire evidence entry becomes the marker.
    if (leaf === undefined) return REDACTED;

    // Only a value the pointer already reaches is replaced, so redaction never adds keys.
    if (readJsonPointer(redacted, pointer) === undefined) continue;
    const parent = readJsonPointer(redacted, pointer.slice(0, pointer.lastIndexOf('/')));

    if (Array.isArray(parent)) parent[Number(leaf)] = REDACTED;
    else if (isJsonObject(parent)) parent[leaf] = REDACTED;
  }

  return redactTransportText(JSON.stringify(redacted), secrets);
};

export { redactEventEvidence, redactTransportText };
