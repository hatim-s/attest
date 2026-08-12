import type { JsonValue, MetricResource } from '@attest/contracts';

import { AttestCliError } from '../../../errors/index.js';

const SENSITIVE_FIELD_NAME =
  /(?:^|[-_])(?:authorization|cookie|password|secret|token|api[-_]?key)(?:$|[-_])/iu;
const AUTHORIZATION_VALUE = /^(?:basic|bearer)\s+\S/iu;

/** Normalizes common identifier styles before credential-field classification. */
const canonicalFieldName = (name: string): string =>
  name
    .normalize('NFKC')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1-$2')
    .replace(/([a-z\d])([A-Z])/gu, '$1-$2')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase();

/** Matches credential fields consistently across casing and separator conventions. */
const isSensitiveFieldName = (name: string): boolean =>
  SENSITIVE_FIELD_NAME.test(canonicalFieldName(name));

/** Locates only actual credential values, not ordinary filenames or analysis option names. */
const credentialArgumentPosition = (argv: readonly string[]): number => {
  for (const [index, argument] of argv.entries()) {
    if (AUTHORIZATION_VALUE.test(argument)) return index;
    const assignment = /^(?:--)?([^=]+)=(.+)$/u.exec(argument);
    if (assignment !== null && isSensitiveFieldName(assignment[1] ?? '')) return index;
    if (!argument.startsWith('-') || !isSensitiveFieldName(argument.replace(/^-+/u, ''))) {
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('-')) return index + 1;
  }
  return -1;
};

/** Rejects credential-like literals while preserving secret references for runtime resolution. */
const assertSafeMetricResource = (metric: MetricResource): void => {
  if (metric.definition.kind === 'exec') {
    const sensitivePosition = credentialArgumentPosition(metric.definition.argv);
    if (sensitivePosition >= 0) {
      throw new AttestCliError(
        'project_invalid',
        'Metric argv cannot contain credential-like literals.',
        {
          path: `/metric/definition/argv/${sensitivePosition}`,
          hint: 'Pass credentials through an environment secret reference.',
        },
      );
    }
    return;
  }
  if (metric.definition.kind !== 'http') return;
  const request = metric.definition.request;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch (error: unknown) {
    throw new AttestCliError('project_invalid', 'HTTP metric URL is invalid.', {
      path: '/metric/definition/request/url',
      cause: error,
    });
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new AttestCliError(
      'project_invalid',
      'HTTP metric URLs cannot contain userinfo credentials.',
      {
        path: '/metric/definition/request/url',
        hint: 'Use a header or query environment secret reference.',
      },
    );
  }
  for (const name of url.searchParams.keys()) {
    if (isSensitiveFieldName(name)) {
      throw new AttestCliError(
        'project_invalid',
        'HTTP metric URLs cannot contain credential-like query values.',
        {
          path: '/metric/definition/request/url',
          hint: 'Use a query environment secret reference.',
        },
      );
    }
  }
  for (const [section, values] of [
    ['headers', request.headers],
    ['query', request.query],
  ] as const) {
    for (const [name, value] of Object.entries(values ?? {})) {
      if (isSensitiveFieldName(name) && typeof value === 'string') {
        throw new AttestCliError(
          'project_invalid',
          'Sensitive HTTP values must use secret references.',
          {
            path: `/metric/definition/request/${section}/${name}`,
            hint: 'Use `{ "from_env": "NAME" }` instead of a literal value.',
          },
        );
      }
    }
  }
  const pending: Array<{ path: string; value: JsonValue }> =
    request.body === undefined
      ? []
      : [{ path: '/metric/definition/request/body', value: request.body }];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || current.value === null || typeof current.value !== 'object') {
      continue;
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((value, index) =>
        pending.push({ path: `${current.path}/${index}`, value }),
      );
      continue;
    }
    for (const [name, value] of Object.entries(current.value)) {
      if (isSensitiveFieldName(name) && value !== null) {
        throw new AttestCliError(
          'project_invalid',
          'HTTP metric bodies cannot contain credential-like authored values.',
          {
            path: `${current.path}/${name}`,
            hint: 'Move credentials to a header or query environment secret reference.',
          },
        );
      }
      pending.push({ path: `${current.path}/${name}`, value });
    }
  }
};

export { assertSafeMetricResource };
