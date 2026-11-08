import type { AgentResource, MetricResource, JsonValue } from '@attest/contracts';

import { REDACTED } from '../../internal/redaction.js';

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

// BOUNDARY: Resource extension fields can contain arbitrary parsed JSON; this guard narrows object containers for credential redaction.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// BOUNDARY: Authored environment and header mappings are sanitized in place after their containers and literal string values are checked.
const redactStringRecord = (value: unknown): void => {
  if (!isRecord(value)) return;

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') value[key] = REDACTED;
  }
};

/** Redacts literal HTTP credentials wherever a request template can be nested. */
// BOUNDARY: Imported request template JSON is traversed and sensitive named fields are removed before display.
const redactRequestTemplates = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(redactRequestTemplates);

    return;
  }

  if (!isRecord(value)) return;

  for (const [key, entry] of Object.entries(value)) {
    if (key === 'headers' || key === 'query') redactStringRecord(entry);

    if ((key === 'url' || key === 'status_url_template') && typeof entry === 'string') {
      value[key] = redactUrl(entry);
    }

    redactRequestTemplates(entry);
  }
};

/** Returns the argv a process transport launches, or undefined for network transports. */
const processArgv = (transport: AgentResource['transport']) => {
  switch (transport.kind) {
    case 'background_cli':
      return transport.start_argv;
    case 'jsonl_bridge':
    case 'native_cli':
      return transport.argv;
    default:
      return undefined;
  }
};

/** Produces a display-only agent clone with declared process arguments and HTTP literals hidden. */
const redactAgentResource = (resource: AgentResource): JsonValue => {
  let redacted = structuredClone(resource);
  redactRequestTemplates(redacted);
  const positions = new Set(redacted.redaction?.argv_positions ?? []);
  const argv = processArgv(redacted.transport);

  if (argv !== undefined) {
    const mask = (value: string, index: number): string =>
      positions.has(index) ? REDACTED : value;

    const [executable, ...rest] = argv;

    // Keeps the non-empty argv shape the transport schema requires.
    const masked: typeof argv = [
      mask(executable, 0),
      ...rest.map((value, index) => mask(value, index + 1)),
    ];

    const transport = redacted.transport;

    if (transport.kind === 'background_cli')
      redacted = { ...redacted, transport: { ...transport, start_argv: masked } };
    else if (transport.kind === 'native_cli' || transport.kind === 'jsonl_bridge')
      redacted = { ...redacted, transport: { ...transport, argv: masked } };
  }

  return redacted;
};

/** Produces a display-only metric clone with literal HTTP header and query values hidden. */
const redactMetricResource = (resource: MetricResource): JsonValue => {
  const redacted = structuredClone(resource);
  redactRequestTemplates(redacted);

  return redacted;
};

export { redactAgentResource, redactMetricResource };
