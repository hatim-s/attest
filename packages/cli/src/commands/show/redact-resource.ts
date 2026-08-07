import type { AgentResource, MetricResource } from '@attest/contracts';

import type { JsonValue } from '../../project/canonical-project.js';

const REDACTED = '[REDACTED]';

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

export { REDACTED, redactAgentResource, redactMetricResource };
