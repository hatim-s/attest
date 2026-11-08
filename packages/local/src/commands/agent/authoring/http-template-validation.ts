import { isJsonArray } from '../../../internal/json-array.js';
import type { AgentResource, JsonValue, SecretReference } from '@attest/contracts';
import * as Effect from 'effect/Effect';

import { LocalError } from '../../../errors/index.js';
import { isSensitiveFieldName } from '../../../internal/redaction.js';

const isJsonObject = (value: JsonValue): value is { [key: string]: JsonValue } =>
  value !== null && typeof value === 'object' && !isJsonArray(value);

const findSensitiveBodyField = (value: JsonValue, path = ''): string | undefined => {
  if (isJsonArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSensitiveBodyField(value[index]!, `${path}/${String(index)}`);

      if (found !== undefined) return found;
    }

    return undefined;
  }

  if (!isJsonObject(value)) return undefined;

  for (const [name, entry] of Object.entries(value)) {
    if (isSensitiveFieldName(name)) return `${path}/${name}`;
    const found = findSensitiveBodyField(entry, `${path}/${name}`);

    if (found !== undefined) return found;
  }

  return undefined;
};

/** Names the first credential-like entry authored as a literal instead of a secret reference. */
// BOUNDARY: Authored header and query maps mix literal strings with secret references; a sensitive name must carry a reference.
const findLiteralSensitiveEntry = (
  entries: Readonly<Record<string, string | SecretReference>> | undefined,
): string | undefined => {
  for (const [name, value] of Object.entries(entries ?? {})) {
    if (isSensitiveFieldName(name) && typeof value === 'string') return name;
  }

  return undefined;
};

/** Rejects an unsafe authored HTTP template and returns its URL with placeholders filled. */
// BOUNDARY: Authored HTTP templates are checked for credential literals, sensitive body fields and unsupported URL forms before requests are allowed.
const assertSafeHttpTemplate = Effect.fn('assertSafeHttpTemplate')(function* (
  request: Extract<AgentResource['transport'], { kind: 'http' }>['request'],
  path: string,
) {
  const separator = request.url.indexOf('://');
  const authorityStart = separator + 3;
  const authorityEnd = request.url.slice(authorityStart).search(/[/?#]/u);

  const authority = request.url.slice(
    authorityStart,
    authorityEnd < 0 ? undefined : authorityStart + authorityEnd,
  );

  if (
    separator <= 0 ||
    request.url.slice(0, authorityStart).includes('{{') ||
    authority.includes('{{')
  ) {
    return yield* new LocalError(
      'project_invalid',
      'Mapped HTTP URL placeholders are allowed only in path or query components.',
      { path },
    );
  }

  const url = yield* Effect.try({
    try: () => new URL(request.url.replaceAll(/\{\{[^}]+\}\}/gu, 'placeholder')),
    catch: () => new LocalError('project_invalid', 'Mapped HTTP URL is invalid.', { path }),
  });

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    url.search.length > 0
  ) {
    return yield* new LocalError(
      'project_invalid',
      'Mapped HTTP URL contains an unsafe component.',
      {
        path,
        hint: 'Keep query mappings separate and remove credentials or fragments from the URL.',
      },
    );
  }

  const literalHeader = findLiteralSensitiveEntry(request.headers);

  if (literalHeader !== undefined) {
    return yield* new LocalError('project_invalid', 'Sensitive HTTP headers must use references.', {
      path: `${path}/headers/${literalHeader}`,
    });
  }

  const literalQuery = findLiteralSensitiveEntry(request.query);

  if (literalQuery !== undefined) {
    return yield* new LocalError(
      'project_invalid',
      'Sensitive HTTP query values must use references.',
      { path: `${path}/query/${literalQuery}` },
    );
  }

  const sensitiveBody =
    request.body === undefined ? undefined : findSensitiveBodyField(request.body);

  if (sensitiveBody !== undefined) {
    return yield* new LocalError(
      'project_invalid',
      'Mapped HTTP bodies cannot contain credentials.',
      {
        path: `${path}/body${sensitiveBody}`,
        hint: 'Move credentials to an environment-backed header or query reference.',
      },
    );
  }

  return url;
});

export { assertSafeHttpTemplate, findLiteralSensitiveEntry, findSensitiveBodyField };
