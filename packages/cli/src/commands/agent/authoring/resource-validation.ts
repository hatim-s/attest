import type { AgentResource } from '@attest/contracts';

import { AttestCliError } from '../../../errors/index.js';
import {
  SENSITIVE_NAME,
  assertSafeHttpTemplate,
  findSensitiveBodyField,
} from './http-template-validation.js';

/** Rejects authored credentials and runtime policies outside the implemented adapter slice. */
const assertSafeNativeAgentResource = (agent: AgentResource): void => {
  const transport = agent.transport;
  const kind = transport.kind;
  const unsupportedTimeoutFields =
    kind === 'websocket'
      ? ['connect_ms', 'first_byte_ms', 'idle_ms', 'attempt_ms', 'run_ms']
      : kind === 'native_cli' || (kind === 'http' && transport.response_mode === 'attest_envelope')
        ? ['connect_ms', 'first_byte_ms', 'idle_ms', 'run_ms']
        : kind === 'http' || kind === 'polling' || kind === 'stream'
          ? ['run_ms']
          : kind === 'jsonl_bridge'
            ? ['connect_ms']
            : [];
  const unsupportedTimeout = unsupportedTimeoutFields.find(
    (field) =>
      agent.timeouts?.[field as keyof NonNullable<AgentResource['timeouts']>] !== undefined,
  );
  const unsupportedLimitFields =
    kind === 'native_cli' || (kind === 'http' && transport.response_mode === 'attest_envelope')
      ? ['request_bytes', 'event_count', 'event_bytes', 'total_evidence_bytes']
      : kind === 'http' || kind === 'polling'
        ? ['event_count', 'event_bytes', 'total_evidence_bytes']
        : kind === 'background_cli'
          ? ['event_count', 'event_bytes']
          : kind === 'stream'
            ? ['response_bytes']
            : [];
  const unsupportedLimit = unsupportedLimitFields.find(
    (field) => agent.limits?.[field as keyof NonNullable<AgentResource['limits']>] !== undefined,
  );
  if (unsupportedTimeout !== undefined || unsupportedLimit !== undefined) {
    const section = unsupportedTimeout === undefined ? 'limits' : 'timeouts';
    const field = unsupportedTimeout ?? unsupportedLimit!;
    throw new AttestCliError(
      'project_invalid',
      'This runtime policy is unsupported by the adapter.',
      {
        path: `/agent/${section}/${field}`,
        hint: 'Remove the unsupported phase or select an adapter that enforces it.',
      },
    );
  }
  if (
    (kind === 'native_cli' && agent.retry !== undefined && agent.retry.backoff.kind !== 'none') ||
    (kind === 'jsonl_bridge' && (agent.retry?.retries ?? 0) > 0)
  ) {
    throw new AttestCliError('project_invalid', 'This retry policy is unsafe for the adapter.', {
      path: '/agent/retry',
      hint:
        kind === 'jsonl_bridge'
          ? 'Set retries to zero; a sent bridge request is never replayed.'
          : 'Use deterministic no-backoff retries for native per-case probes.',
    });
  }
  if (
    transport.kind === 'native_cli' ||
    transport.kind === 'background_cli' ||
    transport.kind === 'jsonl_bridge'
  ) {
    const argv = transport.kind === 'background_cli' ? transport.start_argv : transport.argv;
    for (const position of agent.redaction?.argv_positions ?? []) {
      if (position >= argv.length) {
        throw new AttestCliError('project_invalid', 'An argv redaction position is out of range.', {
          path: `/agent/redaction/argv_positions/${position}`,
        });
      }
    }
    const sensitivePosition = argv.findIndex((argument) => SENSITIVE_NAME.test(argument));
    if (sensitivePosition >= 0) {
      throw new AttestCliError(
        'project_invalid',
        'Native argv cannot contain credential-like literals.',
        {
          path: `/agent/transport/argv/${sensitivePosition}`,
          hint: 'Pass credentials through an environment secret reference.',
        },
      );
    }
    if (transport.kind === 'jsonl_bridge') return;
    if (transport.kind === 'native_cli') return;

    let pattern: RegExp | undefined;
    if (transport.readiness.kind === 'stderr') {
      try {
        pattern = new RegExp(transport.readiness.pattern, 'u');
      } catch (error: unknown) {
        throw new AttestCliError('project_invalid', 'Background readiness regex is invalid.', {
          path: '/agent/transport/readiness/pattern',
          cause: error,
        });
      }
    }
    void pattern;
    const requests = [
      { request: transport.invoke, path: '/agent/transport/invoke' },
      ...(transport.shutdown === undefined
        ? []
        : [{ request: transport.shutdown, path: '/agent/transport/shutdown' }]),
    ];
    const readinessUrl =
      transport.readiness.kind === 'http'
        ? assertSafeHttpTemplate(
            { url: transport.readiness.url, method: 'GET' },
            '/agent/transport/readiness/url',
          )
        : undefined;
    for (const { request, path } of requests) {
      const url = assertSafeHttpTemplate(request, path);
      if (!['localhost', '::1'].includes(url.hostname) && !url.hostname.startsWith('127.')) {
        throw new AttestCliError(
          'project_invalid',
          'Background agents require loopback HTTP endpoints.',
          {
            path: `${path}/url`,
          },
        );
      }
    }
    if (
      readinessUrl !== undefined &&
      !['localhost', '::1'].includes(readinessUrl.hostname) &&
      !readinessUrl.hostname.startsWith('127.')
    ) {
      throw new AttestCliError('project_invalid', 'Background readiness requires a loopback URL.', {
        path: '/agent/transport/readiness/url',
      });
    }
    if (
      transport.readiness.kind === 'tcp' &&
      !['localhost', '::1'].includes(transport.readiness.host) &&
      !transport.readiness.host.startsWith('127.')
    ) {
      throw new AttestCliError(
        'project_invalid',
        'Background TCP readiness requires a loopback host.',
        {
          path: '/agent/transport/readiness/host',
        },
      );
    }
    return;
  }
  if (transport.kind === 'websocket') {
    const sensitiveTemplateField = findSensitiveBodyField(transport.request_template);
    if (sensitiveTemplateField !== undefined) {
      throw new AttestCliError(
        'project_invalid',
        'WebSocket request templates cannot contain credential-like fields.',
        {
          path: `/agent/transport/request_template${sensitiveTemplateField}`,
          hint: 'Move credentials to an environment-backed header reference such as `--header-env Authorization=TOKEN_ENV`.',
        },
      );
    }
    let url: URL;
    try {
      url = new URL(transport.url.replaceAll(/\{\{[^}]+\}\}/gu, 'placeholder'));
    } catch (error: unknown) {
      throw new AttestCliError('project_invalid', 'WebSocket URL template is invalid.', {
        path: '/agent/transport/url',
        cause: error,
      });
    }
    if (url.username.length > 0 || url.password.length > 0) {
      throw new AttestCliError('project_invalid', 'WebSocket URLs cannot contain credentials.', {
        path: '/agent/transport/url',
        hint: 'Move credentials to an environment-backed header reference.',
      });
    }
    for (const [name, value] of Object.entries(transport.headers ?? {})) {
      if (SENSITIVE_NAME.test(name) && typeof value === 'string') {
        throw new AttestCliError(
          'project_invalid',
          'Sensitive WebSocket headers must use references.',
          {
            path: `/agent/transport/headers/${name}`,
            hint: 'Use `{ "from_env": "VARIABLE_NAME" }`; literal secrets are never authored.',
          },
        );
      }
    }
    for (const [name, value] of url.searchParams) {
      if (SENSITIVE_NAME.test(name) && value.length > 0) {
        throw new AttestCliError(
          'project_invalid',
          'Sensitive WebSocket query values are unsupported.',
          {
            path: '/agent/transport/url',
            hint: 'Move credentials to an environment-backed header reference.',
          },
        );
      }
    }
    return;
  }
  const request = transport.kind === 'polling' ? transport.submit : transport.request;
  const requestPath = `/agent/transport/${transport.kind === 'polling' ? 'submit' : 'request'}`;
  if (
    transport.kind === 'http' &&
    transport.response_mode === 'attest_envelope' &&
    (request.method !== 'POST' ||
      request.body !== undefined ||
      request.query !== undefined ||
      transport.extraction.result_pointer !== '' ||
      transport.extraction.error_pointer !== undefined ||
      transport.extraction.trace_pointer !== undefined ||
      transport.extraction.remote_job_id_pointer !== undefined)
  ) {
    throw new AttestCliError('project_invalid', 'Native-envelope HTTP mapping is inconsistent.', {
      path: '/agent/transport/response_mode',
      hint: 'Use the canonical POST envelope shape or select mapped response mode.',
    });
  }
  const origin = assertSafeHttpTemplate(request, requestPath);
  if (transport.kind === 'polling' && transport.status_url_template !== undefined) {
    const status = assertSafeHttpTemplate(
      { url: transport.status_url_template.replaceAll('{{job_id}}', 'job'), method: 'GET' },
      '/agent/transport/status_url_template',
    );
    if (status.origin !== origin.origin) {
      throw new AttestCliError('project_invalid', 'Polling status URL must retain submit origin.', {
        path: '/agent/transport/status_url_template',
      });
    }
  }
  if (
    transport.kind === 'stream' &&
    transport.incremental_output_pointer !== undefined &&
    transport.incremental_output_mode === undefined
  ) {
    throw new AttestCliError(
      'project_invalid',
      'Streaming accumulation requires an explicit mode.',
      {
        path: '/agent/transport/incremental_output_mode',
      },
    );
  }
  for (const name of agent.redaction?.headers ?? []) {
    if (
      !Object.keys(request.headers ?? {}).some(
        (header) => header.toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new AttestCliError('project_invalid', 'A header redaction target does not exist.', {
        path: `/agent/redaction/headers/${name}`,
      });
    }
  }
  for (const name of agent.redaction?.query ?? []) {
    if (!Object.hasOwn(request.query ?? {}, name)) {
      throw new AttestCliError('project_invalid', 'A query redaction target does not exist.', {
        path: `/agent/redaction/query/${name}`,
      });
    }
  }
};

export { assertSafeNativeAgentResource };
