import type { SecretReference } from '@attest/contracts';

/** Distinguishes a literal header, query or template value from its authored secret reference. */
const isLiteralTemplateValue = (value: string | SecretReference | undefined): value is string =>
  typeof value === 'string';

export { isLiteralTemplateValue };
