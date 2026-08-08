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

export { REDACTED, redactTransportText, secretRepresentations };
