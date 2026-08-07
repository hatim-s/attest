import type { AgentResource, MetricResource } from '@attest/contracts';

import type { JsonValue } from '../../project/canonical-project.js';

const REDACTED = '[REDACTED]';

/** Removes userinfo and every literal query value from one display-only URL. */
const redactUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Validated resources should never reach this branch; fail closed for display-only callers.
    return REDACTED;
  }
  const hasUserInfo = parsed.username.length > 0 || parsed.password.length > 0;
  const queryKeys = [...new Set(parsed.searchParams.keys())];
  if (!hasUserInfo && queryKeys.length === 0) return value;
  if (hasUserInfo) {
    parsed.username = REDACTED;
    parsed.password = '';
  }
  queryKeys.forEach((key) => parsed.searchParams.set(key, REDACTED));
  return parsed.toString();
};

const redactStringRecord = (value: unknown): void => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') Reflect.set(value, key, REDACTED);
  }
};

/** Redacts literal HTTP credentials wherever a v2 request template can be nested. */
const redactRequestTemplates = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(redactRequestTemplates);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'headers' || key === 'query') redactStringRecord(entry);
    if ((key === 'url' || key === 'status_url_template') && typeof entry === 'string') {
      Reflect.set(value, key, redactUrl(entry));
    }
    redactRequestTemplates(entry);
  }
};

/** Produces a display-only agent clone with declared process arguments and HTTP literals hidden. */
const redactAgentResource = (resource: AgentResource): JsonValue => {
  const redacted = structuredClone(resource);
  redactRequestTemplates(redacted);
  const positions = new Set(redacted.redaction?.argv_positions ?? []);
  for (const key of ['argv', 'start_argv'] as const) {
    const argv = Reflect.get(redacted.transport, key) as string[] | undefined;
    argv?.forEach((_, index) => {
      if (positions.has(index)) argv[index] = REDACTED;
    });
  }
  return redacted;
};

/** Produces a display-only metric clone with literal HTTP header and query values hidden. */
const redactMetricResource = (resource: MetricResource): JsonValue => {
  const redacted = structuredClone(resource);
  redactRequestTemplates(redacted);
  return redacted;
};

export { REDACTED, redactAgentResource, redactMetricResource, redactUrl };
