import type { AgentResource, JsonValue } from '@attest/contracts';

import { AttestCliError } from '../../../errors/index.js';

const SENSITIVE_NAME = /authorization|cookie|password|secret|token|api[-_]?key/iu;

const findSensitiveBodyField = (value: JsonValue, path = ''): string | undefined => {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSensitiveBodyField(value[index]!, `${path}/${String(index)}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  for (const [name, entry] of Object.entries(value)) {
    if (SENSITIVE_NAME.test(name)) return `${path}/${name}`;
    const found = findSensitiveBodyField(entry, `${path}/${name}`);
    if (found !== undefined) return found;
  }
  return undefined;
};

const assertSafeHttpTemplate = (
  request: Extract<AgentResource['transport'], { kind: 'http' }>['request'],
  path: string,
): URL => {
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
    throw new AttestCliError(
      'project_invalid',
      'Mapped HTTP URL placeholders are allowed only in path or query components.',
      { path },
    );
  }
  let url: URL;
  try {
    url = new URL(request.url.replaceAll(/\{\{[^}]+\}\}/gu, 'placeholder'));
  } catch {
    throw new AttestCliError('project_invalid', 'Mapped HTTP URL is invalid.', { path });
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    url.search.length > 0
  ) {
    throw new AttestCliError('project_invalid', 'Mapped HTTP URL contains an unsafe component.', {
      path,
      hint: 'Keep query mappings separate and remove credentials or fragments from the URL.',
    });
  }
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (SENSITIVE_NAME.test(name) && typeof value === 'string') {
      throw new AttestCliError('project_invalid', 'Sensitive HTTP headers must use references.', {
        path: `${path}/headers/${name}`,
      });
    }
  }
  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (SENSITIVE_NAME.test(name) && typeof value === 'string') {
      throw new AttestCliError(
        'project_invalid',
        'Sensitive HTTP query values must use references.',
        {
          path: `${path}/query/${name}`,
        },
      );
    }
  }
  const sensitiveBody =
    request.body === undefined ? undefined : findSensitiveBodyField(request.body);
  if (sensitiveBody !== undefined) {
    throw new AttestCliError('project_invalid', 'Mapped HTTP bodies cannot contain credentials.', {
      path: `${path}/body${sensitiveBody}`,
      hint: 'Move credentials to an environment-backed header or query reference.',
    });
  }
  return url;
};

export { SENSITIVE_NAME, assertSafeHttpTemplate, findSensitiveBodyField };
