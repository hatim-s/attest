import { splitJsonPointer } from './json-pointer.js';

const REDACTED = '[REDACTED]';

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
    percentEncoded.toLowerCase(),
    formEncoded,
    bytes.toString('base64'),
    bytes.toString('base64url'),
    bytes.toString('hex'),
  ]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
};

/** Redacts literal, escaped, percent/form encoded, and common byte encodings of runtime secrets. */
const redactTransportText = (value: string, secrets: readonly string[]): string =>
  [...new Set(secrets.flatMap(secretRepresentations))].reduce(
    (redacted, secret) => redacted.replaceAll(secret, REDACTED),
    value,
  );

const isContainer = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

/** Replaces authored sensitive event fields before an event becomes persisted evidence. */
const redactEventEvidence = (
  value: unknown,
  pointers: readonly string[],
  secrets: readonly string[],
): string => {
  const redacted = structuredClone(value);
  for (const pointer of pointers) {
    const segments = splitJsonPointer(pointer);
    const leaf = segments.pop();
    // The root pointer names the whole event, so the entire evidence entry becomes the marker.
    if (leaf === undefined) return REDACTED;
    let parent: unknown = redacted;
    for (const segment of segments) {
      parent = isContainer(parent) && Object.hasOwn(parent, segment) ? parent[segment] : undefined;
    }
    if (isContainer(parent) && Object.hasOwn(parent, leaf)) parent[leaf] = REDACTED;
  }
  return redactTransportText(JSON.stringify(redacted), secrets);
};

export { redactEventEvidence, redactTransportText };
