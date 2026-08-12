import {
  AGENT_RESOURCE_SCHEMA_ID,
  METRIC_RESOURCE_SCHEMA_ID,
  agentResourceSchema,
  metricResourceSchema,
  type AgentResource,
} from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { redactAgentResource, redactMetricResource } from '../redact-resource.js';

const credentialUrl = (label: string, scheme = 'https'): string =>
  `${scheme}://user:${label}-password@example.test/path?token=${label}-token&key=${label}-key`;

/** Parses first so every redaction case is proven valid under the authored schema. */
const validAgent = (id: string, transport: AgentResource['transport']): AgentResource =>
  agentResourceSchema.parse({
    schema: AGENT_RESOURCE_SCHEMA_ID,
    id,
    name: id,
    transport,
  });

describe('resource output URL redaction', () => {
  it.each([
    validAgent('http-agent', {
      kind: 'http',
      lifecycle: 'external',
      response_mode: 'mapped',
      request: { method: 'POST', url: credentialUrl('http') },
      extraction: { result_pointer: '/result' },
    }),
    validAgent('background-agent', {
      kind: 'background_cli',
      lifecycle: 'per_run',
      start_argv: ['node', 'agent.mjs'],
      readiness: { kind: 'http', url: credentialUrl('readiness') },
      invoke: { method: 'POST', url: credentialUrl('invoke') },
      extraction: { result_pointer: '/result' },
      shutdown: { method: 'POST', url: credentialUrl('shutdown') },
      stop_timeout_ms: 1_000,
    }),
    validAgent('polling-agent', {
      kind: 'polling',
      lifecycle: 'external',
      submit: { method: 'POST', url: credentialUrl('submit') },
      job_id_pointer: '/job_id',
      status_url_template: credentialUrl('status'),
      status_pointer: '/status',
      success_values: ['done'],
      failure_values: ['failed'],
      extraction: { result_pointer: '/result' },
      minimum_interval_ms: 1,
      maximum_interval_ms: 10,
    }),
    validAgent('stream-agent', {
      kind: 'stream',
      lifecycle: 'external',
      framing: 'sse',
      request: { method: 'POST', url: credentialUrl('stream') },
      terminal_pointer: '/status',
      terminal_values: ['done'],
      result_pointer: '/result',
      heartbeat_resets_application_idle: false,
    }),
    validAgent('websocket-agent', {
      kind: 'websocket',
      lifecycle: 'per_case',
      connection_mode: 'serial',
      framing: 'text_json',
      url: credentialUrl('websocket', 'wss'),
      request_template: { request_id: '{{request_id}}' },
      request_id_pointer: '/request_id',
      acknowledgement_pointer: '/acknowledged',
      acknowledgement_values: [true],
      result_pointer: '/result',
      error_pointer: '/error',
      trace_pointer: '/trace',
      open_timeout_ms: 1_000,
      message_idle_timeout_ms: 10_000,
      attempt_timeout_ms: 30_000,
      ping_interval_ms: 5_000,
      close_timeout_ms: 1_000,
      retry_boundary: 'before_acknowledgement',
      replay_after_acknowledgement: false,
    }),
  ])('redacts every URL-bearing field on $id', (agent) => {
    const output = JSON.stringify(redactAgentResource(agent));
    expect(output).toContain('REDACTED');
    expect(output).not.toMatch(
      /(?:http|readiness|invoke|shutdown|submit|status|stream|websocket)-(?:password|token|key)/u,
    );
  });

  it('redacts schema-valid HTTP metric URL credentials', () => {
    const metric = metricResourceSchema.parse({
      schema: METRIC_RESOURCE_SCHEMA_ID,
      id: 'remote-metric',
      name: 'Remote metric',
      definition: {
        kind: 'http',
        request: { method: 'POST', url: credentialUrl('metric') },
        extraction: { score_pointer: '/score', pass_pointer: '/pass' },
      },
    });
    const output = JSON.stringify(redactMetricResource(metric));
    expect(output).toContain('REDACTED');
    expect(output).not.toMatch(/metric-(?:password|token|key)/u);
  });
});
