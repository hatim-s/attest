import { commandRequestSchema, type JsonValue } from '@attest/contracts';

import { AttestCliError } from '../../../errors/index.js';
import { parseDuration } from '../agent-request.js';
import { CurlImportError, parseCurlCommand } from '../import/curl/index.js';
import {
  commaSeparated,
  promptDefault,
  promptOptional,
  promptRequired,
} from './command-support.js';
import type { AgentImportCommandOptions, CurlImportRequest } from './types.js';

const parseEnvironmentBindings = (
  values: readonly string[] | undefined,
  path: string,
): Record<string, string> | undefined => {
  if (values === undefined || values.length === 0) return undefined;
  const bindings: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    const target = value.slice(0, separator).trim();
    const environment = value.slice(separator + 1).trim();
    if (separator <= 0 || target.length === 0 || environment.length === 0) {
      throw new AttestCliError('cli_usage', 'A cURL secret binding is invalid.', {
        path,
        hint: 'Use TARGET_NAME=SOURCE_ENV; the captured value is discarded.',
      });
    }
    if (Object.keys(bindings).some((name) => name.toLowerCase() === target.toLowerCase())) {
      throw new AttestCliError('cli_usage', 'A cURL secret binding is duplicated.', { path });
    }
    bindings[target] = environment;
  }
  return bindings;
};

const parseBodyMappings = (
  values: readonly string[] | undefined,
): CurlImportRequest['placeholders'] =>
  values?.map((value) => {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new AttestCliError('cli_usage', 'A cURL body mapping is invalid.', {
        path: '--map-body',
        hint: 'Use TARGET_JSON_POINTER=INPUT_JSON_POINTER.',
      });
    }
    return {
      target_pointer: value.slice(0, separator),
      input_pointer: value.slice(separator + 1),
    };
  });

const parsePositiveInteger = (value: string | undefined, path: string): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AttestCliError('cli_usage', 'Value must be a positive integer.', { path });
  }
  return parsed;
};

const parseRetryCount = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AttestCliError('cli_usage', 'Retry count must be a non-negative integer.', {
      path: '--retries',
    });
  }
  return parsed;
};

const parseJsonValues = (
  values: readonly string[] | undefined,
  path: string,
): JsonValue[] | undefined =>
  values?.map((value) => {
    try {
      return JSON.parse(value) as JsonValue;
    } catch (error: unknown) {
      throw new AttestCliError('cli_usage', 'Polling terminal value is not valid JSON.', {
        path,
        cause: error,
      });
    }
  });

/** Normalizes cURL import flags through the same request schema as --from-json. */
const createCurlImportRequest = (fields: {
  agentId: string;
  name?: string;
  options: AgentImportCommandOptions;
  responsePointer: string;
  source: string;
}): CurlImportRequest => {
  const { options } = fields;
  const pollingSelected =
    options.pollJobIdPointer !== undefined ||
    options.pollStatusPointer !== undefined ||
    options.pollStatusUrlPointer !== undefined ||
    options.pollStatusUrlTemplate !== undefined ||
    options.pollSuccess !== undefined ||
    options.pollFailure !== undefined ||
    options.pollMinimumInterval !== undefined ||
    options.pollMaximumInterval !== undefined ||
    options.idempotencyHeader !== undefined;
  const successes = parseJsonValues(options.pollSuccess, '--poll-success');
  const failures = parseJsonValues(options.pollFailure, '--poll-failure');
  const retries = parseRetryCount(options.retries);
  const retryDelay =
    options.retryDelay === undefined
      ? undefined
      : parseDuration(options.retryDelay, '--retry-delay');
  if (retryDelay !== undefined && retries === undefined) {
    throw new AttestCliError('cli_usage', '--retry-delay requires --retries.', {
      path: '--retry-delay',
    });
  }
  const candidate = {
    schema: 'attest.command-request',
    command: 'agent.import',
    source: fields.source,
    source_type: 'curl',
    as: fields.agentId,
    ...(fields.name === undefined ? {} : { name: fields.name }),
    ...(options.mapBody === undefined ? {} : { placeholders: parseBodyMappings(options.mapBody) }),
    ...(options.headerEnv === undefined
      ? {}
      : { header_env: parseEnvironmentBindings(options.headerEnv, '--header-env') }),
    ...(options.queryEnv === undefined
      ? {}
      : { query_env: parseEnvironmentBindings(options.queryEnv, '--query-env') }),
    extraction: {
      result_pointer: fields.responsePointer,
      ...(options.errorPointer === undefined ? {} : { error_pointer: options.errorPointer }),
      ...(options.tracePointer === undefined ? {} : { trace_pointer: options.tracePointer }),
      ...(options.remoteJobIdPointer === undefined
        ? {}
        : { remote_job_id_pointer: options.remoteJobIdPointer }),
    },
    ...(pollingSelected
      ? {
          polling: {
            job_id_pointer: options.pollJobIdPointer,
            ...(options.pollStatusUrlPointer === undefined
              ? {}
              : { status_url_pointer: options.pollStatusUrlPointer }),
            ...(options.pollStatusUrlTemplate === undefined
              ? {}
              : { status_url_template: options.pollStatusUrlTemplate }),
            status_pointer: options.pollStatusPointer,
            success_values: successes,
            failure_values: failures,
            minimum_interval_ms:
              options.pollMinimumInterval === undefined
                ? undefined
                : parseDuration(options.pollMinimumInterval, '--poll-minimum-interval'),
            maximum_interval_ms:
              options.pollMaximumInterval === undefined
                ? undefined
                : parseDuration(options.pollMaximumInterval, '--poll-maximum-interval'),
            ...(options.idempotencyHeader === undefined
              ? {}
              : { idempotency_header: options.idempotencyHeader }),
          },
        }
      : {}),
    ...([
      options.connectTimeout,
      options.firstByteTimeout,
      options.bodyTimeout,
      options.attemptTimeout,
    ].every((value) => value === undefined)
      ? {}
      : {
          timeouts: {
            ...(options.connectTimeout === undefined
              ? {}
              : { connect_ms: parseDuration(options.connectTimeout, '--connect-timeout') }),
            ...(options.firstByteTimeout === undefined
              ? {}
              : { first_byte_ms: parseDuration(options.firstByteTimeout, '--first-byte-timeout') }),
            ...(options.bodyTimeout === undefined
              ? {}
              : { idle_ms: parseDuration(options.bodyTimeout, '--body-timeout') }),
            ...(options.attemptTimeout === undefined
              ? {}
              : { attempt_ms: parseDuration(options.attemptTimeout, '--attempt-timeout') }),
          },
        }),
    ...(retries === undefined
      ? {}
      : {
          retry: {
            retries,
            backoff:
              retryDelay === undefined ? { kind: 'none' } : { kind: 'fixed', delay_ms: retryDelay },
          },
        }),
    ...(options.requestCapBytes === undefined && options.responseCapBytes === undefined
      ? {}
      : {
          limits: {
            ...(options.requestCapBytes === undefined
              ? {}
              : {
                  request_bytes: parsePositiveInteger(
                    options.requestCapBytes,
                    '--request-cap-bytes',
                  ),
                }),
            ...(options.responseCapBytes === undefined
              ? {}
              : {
                  response_bytes: parsePositiveInteger(
                    options.responseCapBytes,
                    '--response-cap-bytes',
                  ),
                }),
          },
        }),
    ...(options.dryRun === undefined ? {} : { dry_run: options.dryRun }),
    ...(options.expectedProjectHash === undefined
      ? {}
      : { if_project_hash: options.expectedProjectHash }),
    ...(options.yes === undefined ? {} : { yes: options.yes }),
  };
  const parsed = commandRequestSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.command !== 'agent.import' ||
    parsed.data.source_type !== 'curl'
  ) {
    throw new AttestCliError('cli_usage', 'cURL import flags are incomplete or inconsistent.', {
      path: '--type',
      hint: 'Provide extraction pointers and every required polling field.',
      details: {
        diagnostics: parsed.success
          ? []
          : parsed.error.issues.map(({ message, path }) => ({
              message,
              path: `/${path.join('/')}`,
            })),
      },
    });
  }
  return parsed.data;
};

/** Completes the human cURL happy path without retaining any captured credential literal. */
const prepareGuidedCurlOptions = async (
  options: AgentImportCommandOptions,
  source: string,
): Promise<AgentImportCommandOptions> => {
  if (!options.interactive || options.prompt === undefined) return options;
  const guided: AgentImportCommandOptions = {
    ...options,
    headerEnv: [...(options.headerEnv ?? [])],
    queryEnv: [...(options.queryEnv ?? [])],
  };
  // Reparse after each discovered credential name; the literal value is never copied into a prompt.
  for (let attempt = 0; attempt < 32; attempt += 1) {
    try {
      parseCurlCommand(source, {
        headerSecrets: parseEnvironmentBindings(guided.headerEnv, '--header-env'),
        querySecrets: parseEnvironmentBindings(guided.queryEnv, '--query-env'),
      });
      break;
    } catch (error: unknown) {
      if (!(error instanceof CurlImportError)) throw error;
      const unsafe = error.diagnostics.find(
        (diagnostic) =>
          diagnostic.startsWith('unsafe_header:') || diagnostic.startsWith('unsafe_query:'),
      );
      if (unsafe === undefined) break;
      const [kind, name] = unsafe.split(':') as [string, string];
      const environment = await promptRequired(
        undefined,
        `${kind === 'unsafe_header' ? 'Header' : 'Query'} ${name} environment variable`,
        kind === 'unsafe_header' ? '--header-env' : '--query-env',
        true,
        options.prompt,
      );
      const binding = `${name}=${environment}`;
      if (kind === 'unsafe_header') guided.headerEnv = [...(guided.headerEnv ?? []), binding];
      else guided.queryEnv = [...(guided.queryEnv ?? []), binding];
    }
  }
  if (options.mapBody === undefined) {
    guided.mapBody = commaSeparated(
      await options.prompt('Body mappings TARGET_POINTER=INPUT_POINTER, comma-separated [none]: '),
    );
  }
  guided.errorPointer = await promptOptional(
    options.errorPointer,
    'Error JSON Pointer',
    true,
    options.prompt,
  );
  guided.tracePointer = await promptOptional(
    options.tracePointer,
    'Trace JSON Pointer',
    true,
    options.prompt,
  );
  guided.remoteJobIdPointer = await promptOptional(
    options.remoteJobIdPointer,
    'Remote job id JSON Pointer',
    true,
    options.prompt,
  );
  const pollingSelected =
    options.pollJobIdPointer !== undefined ||
    options.pollStatusPointer !== undefined ||
    options.pollStatusUrlPointer !== undefined ||
    options.pollStatusUrlTemplate !== undefined ||
    options.pollSuccess !== undefined ||
    options.pollFailure !== undefined;
  const transport = pollingSelected
    ? 'polling'
    : await promptDefault(undefined, 'Transport', 'direct', true, options.prompt);
  if (!['direct', 'polling'].includes(transport)) {
    throw new AttestCliError('cli_usage', 'Transport must be direct or polling.', {
      path: 'transport',
    });
  }
  if (transport === 'polling') {
    guided.pollJobIdPointer = await promptDefault(
      options.pollJobIdPointer,
      'Submission job id JSON Pointer',
      '/job_id',
      true,
      options.prompt,
    );
    if (options.pollStatusUrlPointer === undefined && options.pollStatusUrlTemplate === undefined) {
      const sourceChoice = await promptDefault(
        undefined,
        'Status URL source',
        'pointer',
        true,
        options.prompt,
      );
      if (sourceChoice === 'pointer') {
        guided.pollStatusUrlPointer = await promptDefault(
          undefined,
          'Submission status URL JSON Pointer',
          '/status_url',
          true,
          options.prompt,
        );
      } else if (sourceChoice === 'template') {
        guided.pollStatusUrlTemplate = await promptRequired(
          undefined,
          'Same-origin status URL template with {{job_id}}',
          '--poll-status-url-template',
          true,
          options.prompt,
        );
      } else {
        throw new AttestCliError('cli_usage', 'Status URL source must be pointer or template.', {
          path: 'status-url-source',
        });
      }
    }
    guided.pollStatusPointer = await promptDefault(
      options.pollStatusPointer,
      'Polling status JSON Pointer',
      '/status',
      true,
      options.prompt,
    );
    guided.pollSuccess = options.pollSuccess ??
      commaSeparated(
        await options.prompt('Polling success JSON values, comma-separated ["done"]: '),
      ) ?? ['"done"'];
    guided.pollFailure = options.pollFailure ??
      commaSeparated(
        await options.prompt('Polling failure JSON values, comma-separated ["failed"]: '),
      ) ?? ['"failed"'];
    guided.pollMinimumInterval = await promptDefault(
      options.pollMinimumInterval,
      'Minimum polling interval',
      '1s',
      true,
      options.prompt,
    );
    guided.pollMaximumInterval = await promptDefault(
      options.pollMaximumInterval,
      'Maximum polling interval',
      '5s',
      true,
      options.prompt,
    );
    guided.idempotencyHeader = await promptOptional(
      options.idempotencyHeader,
      'Submission idempotency header',
      true,
      options.prompt,
    );
  }
  return guided;
};

export { createCurlImportRequest, prepareGuidedCurlOptions };
