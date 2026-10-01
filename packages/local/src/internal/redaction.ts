/** Replaces every redacted value in evidence, previews, and shown resources. */
const REDACTED = '[REDACTED]';

const SENSITIVE_FIELD_NAME =
  /(?:^|[-_])(?:authorization|cookie|password|secret|token|api[-_]?key)(?:$|[-_])/iu;

/** Normalizes camelCase, snake_case, and Unicode variants to one kebab-case form. */
const canonicalFieldName = (name: string): string =>
  name
    .normalize('NFKC')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1-$2')
    .replace(/([a-z\d])([A-Z])/gu, '$1-$2')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase();

/**
 * Decides whether a header, query, body, or argv name holds a credential. Matching whole words
 * after normalization catches `X-Api-Key` and `sessionToken` without flagging `max_tokens`.
 */
const isSensitiveFieldName = (name: string): boolean =>
  SENSITIVE_FIELD_NAME.test(canonicalFieldName(name));

export { REDACTED, isSensitiveFieldName };
