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

const pointerSegments = (pointer: string): string[] =>
  pointer === ''
    ? []
    : pointer
        .slice(1)
        .split('/')
        .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));

/** Replaces authored sensitive event fields before an event becomes persisted evidence. */
const redactEventEvidence = (
  value: unknown,
  pointers: readonly string[],
  secrets: readonly string[],
): string => {
  const redacted = structuredClone(value);
  for (const pointer of pointers) {
    const segments = pointerSegments(pointer);
    if (segments.length === 0) return REDACTED;
    let parent: unknown = redacted;
    for (const segment of segments.slice(0, -1)) {
      if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, segment)) {
        parent = undefined;
        break;
      }
      parent = Reflect.get(parent, segment);
    }
    if (parent !== null && typeof parent === 'object') {
      const leaf = segments.at(-1);
      if (leaf !== undefined && Object.hasOwn(parent, leaf)) Reflect.set(parent, leaf, REDACTED);
    }
  }
  return redactTransportText(JSON.stringify(redacted), secrets);
};

export { REDACTED, redactEventEvidence, redactTransportText, secretRepresentations };
