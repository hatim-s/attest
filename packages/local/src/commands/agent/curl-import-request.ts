import { commandRequestSchema } from '@attest/contracts';

import { LocalError } from '../../errors/index.js';
import { schemaIssueDiagnostics } from '../../internal/schema-issue-diagnostics.js';
import { parseSecretBindings } from '../shared/secret-bindings.js';
import { parseDuration, parseJsonValues } from './authoring/input-parsers.js';
import { parseCurlCommand } from './curl-parser.js';
import { CurlImportError } from './curl-tokenizer.js';
import type { AgentRequest } from './types.js';

type CurlImportRequest = Extract<AgentRequest<'agent.import'>, { source_type: 'curl' }>;

/** CLI drafts can omit polling fields until commandRequestSchema reports every missing value. */
type CurlImportCandidate = Omit<CurlImportRequest, 'polling'> & {
  polling?: Partial<NonNullable<CurlImportRequest['polling']>>;
};

/** cURL import flags, before they become one validated agent.import request. */
type CurlImportFields = {
  agentId: string;
  attemptTimeout?: string;
  bodyTimeout?: string;
  connectTimeout?: string;
  dryRun?: boolean;
  errorPointer?: string;
  expectedProjectHash?: string;
  firstByteTimeout?: string;
  headerEnv?: readonly string[];
  idempotencyHeader?: string;
  mapBody?: readonly string[];
  name?: string;
  pollFailure?: readonly string[];
  pollJobIdPointer?: string;
  pollMaximumInterval?: string;
  pollMinimumInterval?: string;
  pollStatusPointer?: string;
  pollStatusUrlPointer?: string;
  pollStatusUrlTemplate?: string;
  pollSuccess?: readonly string[];
  queryEnv?: readonly string[];
  remoteJobIdPointer?: string;
  requestCapBytes?: string;
  responseCapBytes?: string;
  responsePointer: string;
  retries?: string;
  retryDelay?: string;
  source: string;
  tracePointer?: string;
  yes?: boolean;
};

/** Parser diagnostics a user can fix by re-entering `--map-body` values. */
const CURL_MAPPING_DIAGNOSTICS: ReadonlySet<string> = new Set([
  'invalid_form_target',
  'invalid_input_pointer',
  'invalid_target_pointer',
  'missing_body',
  'missing_target_pointer',
  'raw_body_mapping',
]);

/** Maps header or query secret bindings to environment names; names match case-insensitively. */
const parseEnvironmentBindings = (
  values: readonly string[] | undefined,
  path: string,
): Record<string, string> | undefined => {
  if (values === undefined || values.length === 0) return undefined;
  const bindings = Object.entries(parseSecretBindings(values, path));
  const names = new Set(bindings.map(([target]) => target.toLowerCase()));

  if (names.size !== values.length) {
    throw new LocalError('cli_usage', 'A cURL secret binding is duplicated.', { path });
  }

  return Object.fromEntries(bindings.map(([target, reference]) => [target, reference.from_env]));
};

const parseBodyMappings = (
  values: readonly string[] | undefined,
): CurlImportRequest['placeholders'] =>
  values?.map((value) => {
    const separator = value.indexOf('=');

    if (separator <= 0) {
      throw new LocalError('cli_usage', 'A cURL body mapping is invalid.', {
        path: '--map-body',
        hint: 'Use TARGET_JSON_POINTER=INPUT_JSON_POINTER.',
      });
    }

    return {
      target_pointer: value.slice(0, separator),
      input_pointer: value.slice(separator + 1),
    };
  });

const parseInteger = (value: string, path: string, options: { min: number }): number => {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < options.min) {
    throw new LocalError('cli_usage', `${path} must be an integer of at least ${options.min}.`, {
      path,
    });
  }

  return parsed;
};

/** True when any polling flag was passed, which selects the polling transport. */
const pollingFlagsPresent = (
  options: Omit<CurlImportFields, 'agentId' | 'responsePointer' | 'source'>,
): boolean =>
  [
    options.pollJobIdPointer,
    options.pollStatusPointer,
    options.pollStatusUrlPointer,
    options.pollStatusUrlTemplate,
    options.pollSuccess,
    options.pollFailure,
    options.pollMinimumInterval,
    options.pollMaximumInterval,
    options.idempotencyHeader,
  ].some((value) => value !== undefined);

/** Normalizes cURL import flags through the same request schema as --from-json. */
const createCurlImportRequest = (fields: CurlImportFields): CurlImportRequest => {
  const options = fields;
  const pollingSelected = pollingFlagsPresent(options);

  const successes =
    options.pollSuccess === undefined
      ? undefined
      : parseJsonValues(options.pollSuccess, '--poll-success');

  const failures =
    options.pollFailure === undefined
      ? undefined
      : parseJsonValues(options.pollFailure, '--poll-failure');

  const retries =
    options.retries === undefined
      ? undefined
      : parseInteger(options.retries, '--retries', { min: 0 });

  const retryDelay =
    options.retryDelay === undefined
      ? undefined
      : parseDuration(options.retryDelay, '--retry-delay');

  if (retryDelay !== undefined && retries === undefined) {
    throw new LocalError('cli_usage', '--retry-delay requires --retries.', {
      path: '--retry-delay',
    });
  }

  const candidate: CurlImportCandidate = {
    schema: 'attest.command-request',
    command: 'agent.import',
    source: fields.source,
    source_type: 'curl',
    as: fields.agentId,
    extraction: { result_pointer: fields.responsePointer },
  };

  if (fields.name !== undefined) candidate.name = fields.name;

  if (options.mapBody !== undefined) candidate.placeholders = parseBodyMappings(options.mapBody);

  if (options.headerEnv !== undefined)
    candidate.header_env = parseEnvironmentBindings(options.headerEnv, '--header-env');

  if (options.queryEnv !== undefined)
    candidate.query_env = parseEnvironmentBindings(options.queryEnv, '--query-env');

  if (options.errorPointer !== undefined) candidate.extraction.error_pointer = options.errorPointer;

  if (options.tracePointer !== undefined) candidate.extraction.trace_pointer = options.tracePointer;

  if (options.remoteJobIdPointer !== undefined)
    candidate.extraction.remote_job_id_pointer = options.remoteJobIdPointer;

  if (pollingSelected) {
    const polling: NonNullable<CurlImportCandidate['polling']> = {
      job_id_pointer: options.pollJobIdPointer,
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
    };

    if (options.pollStatusUrlPointer !== undefined)
      polling.status_url_pointer = options.pollStatusUrlPointer;

    if (options.pollStatusUrlTemplate !== undefined)
      polling.status_url_template = options.pollStatusUrlTemplate;

    if (options.idempotencyHeader !== undefined)
      polling.idempotency_header = options.idempotencyHeader;
    candidate.polling = polling;
  }

  if (
    ![
      options.connectTimeout,
      options.firstByteTimeout,
      options.bodyTimeout,
      options.attemptTimeout,
    ].every((value) => value === undefined)
  ) {
    const timeouts: NonNullable<CurlImportRequest['timeouts']> = {};

    if (options.connectTimeout !== undefined)
      timeouts.connect_ms = parseDuration(options.connectTimeout, '--connect-timeout');

    if (options.firstByteTimeout !== undefined)
      timeouts.first_byte_ms = parseDuration(options.firstByteTimeout, '--first-byte-timeout');

    if (options.bodyTimeout !== undefined)
      timeouts.idle_ms = parseDuration(options.bodyTimeout, '--body-timeout');

    if (options.attemptTimeout !== undefined)
      timeouts.attempt_ms = parseDuration(options.attemptTimeout, '--attempt-timeout');
    candidate.timeouts = timeouts;
  }

  if (retries !== undefined)
    candidate.retry = {
      retries,
      backoff:
        retryDelay === undefined ? { kind: 'none' } : { kind: 'fixed', delay_ms: retryDelay },
    };

  if (options.requestCapBytes !== undefined || options.responseCapBytes !== undefined) {
    const limits: NonNullable<CurlImportRequest['limits']> = {};

    if (options.requestCapBytes !== undefined)
      limits.request_bytes = parseInteger(options.requestCapBytes, '--request-cap-bytes', {
        min: 1,
      });

    if (options.responseCapBytes !== undefined)
      limits.response_bytes = parseInteger(options.responseCapBytes, '--response-cap-bytes', {
        min: 1,
      });
    candidate.limits = limits;
  }

  if (options.dryRun !== undefined) candidate.dry_run = options.dryRun;

  if (options.expectedProjectHash !== undefined)
    candidate.if_project_hash = options.expectedProjectHash;

  if (options.yes !== undefined) candidate.yes = options.yes;

  const parsed = commandRequestSchema.safeParse(candidate);

  if (
    !parsed.success ||
    parsed.data.command !== 'agent.import' ||
    parsed.data.source_type !== 'curl'
  ) {
    throw new LocalError('cli_usage', 'cURL import flags are incomplete or inconsistent.', {
      path: '--type',
      hint: 'Provide extraction pointers and every required polling field.',
      details: { diagnostics: parsed.success ? [] : schemaIssueDiagnostics(parsed.error.issues) },
    });
  }

  return parsed.data;
};

/**
 * Finds the first sensitive header or query value in a cURL source that has no environment
 * binding yet, so a guided import can ask for one. Returns the name only; the captured value
 * never leaves the parser.
 */
const findUnboundCurlCredential = (
  source: string,
  bindings: Pick<CurlImportFields, 'headerEnv' | 'queryEnv'>,
): { kind: 'header' | 'query'; name: string } | undefined => {
  try {
    parseCurlCommand(source, {
      headerSecrets: parseEnvironmentBindings(bindings.headerEnv, '--header-env'),
      querySecrets: parseEnvironmentBindings(bindings.queryEnv, '--query-env'),
    });

    return undefined;
  } catch (error: unknown) {
    if (!(error instanceof CurlImportError)) throw error;

    for (const diagnostic of error.diagnostics) {
      const [kind, name] = diagnostic.split(':');

      if (name === undefined) continue;

      if (kind === 'unsafe_header') return { kind: 'header', name };

      if (kind === 'unsafe_query') return { kind: 'query', name };
    }

    return undefined;
  }
};

export {
  CURL_MAPPING_DIAGNOSTICS,
  createCurlImportRequest,
  findUnboundCurlCredential,
  pollingFlagsPresent,
  type CurlImportFields,
};
