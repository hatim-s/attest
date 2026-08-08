import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  commandRequestSchema,
  type AgentResource,
  type CommandRequest,
  type JsonValue,
  type ProjectResources,
} from '@attest/contracts';
import { openStore } from '@attest/core';

import { AttestCliError } from '../../errors.js';
import { CurlImportError, parseCurlCommand } from '../../import/curl/index.js';
import { discoverProject } from '../../project/discover-project.js';
import { applyProjectMutation, type PublishObserver } from '../../project/transaction/index.js';
import type { CommandResult } from '../command-result.js';
import { loadCommandProject } from '../project/load-command-project.js';
import {
  assertSafeNativeAgentResource,
  createImportedCurlAgentResource,
  createAgentResource,
  parseDuration,
  readAgentCommandRequest,
  readCurlDocument,
  readImportedAgentResource,
  type ReadInput,
} from './agent-request.js';
import { testNativeAgentConnection } from './native-agent-adapter.js';

type Prompt = (question: string, options?: { signal?: AbortSignal }) => Promise<string>;

type MutationFields = {
  dryRun?: boolean;
  expectedProjectHash?: string;
  fromJson?: string;
  project?: string;
  publishObserver?: PublishObserver;
  readStdin: ReadInput;
  workingDirectory: string;
  yes?: boolean;
};

type AgentAddCommandOptions = MutationFields & {
  agentId?: string;
  argvJson?: string;
  env?: readonly string[];
  headerEnv?: readonly string[];
  interactive: boolean;
  name?: string;
  nativeCommand?: string;
  nativeHttp?: string;
  prompt?: Prompt;
  timeout?: string;
  trace?: boolean;
};

type AgentImportCommandOptions = MutationFields & {
  agentId?: string;
  attemptTimeout?: string;
  bodyTimeout?: string;
  connectTimeout?: string;
  errorPointer?: string;
  firstByteTimeout?: string;
  headerEnv?: readonly string[];
  idempotencyHeader?: string;
  interactive: boolean;
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
  prompt?: Prompt;
  queryEnv?: readonly string[];
  requestCapBytes?: string;
  responseCapBytes?: string;
  responsePointer?: string;
  retries?: string;
  retryDelay?: string;
  remoteJobIdPointer?: string;
  source?: string;
  sourceType?: string;
  tracePointer?: string;
};

type AgentRenameCommandOptions = MutationFields & {
  agentId?: string;
  interactive: boolean;
  newId?: string;
  prompt?: Prompt;
};

type AgentRemoveCommandOptions = MutationFields & {
  agentId?: string;
  detach?: boolean;
  interactive: boolean;
  prompt?: Prompt;
};

type AgentTestCommandOptions = {
  agentId?: string;
  fromJson?: string;
  input?: string;
  inputFile?: string;
  interactive: boolean;
  onProgress?: (message: string) => void;
  project?: string;
  prompt?: Prompt;
  readStdin: ReadInput;
  signal?: AbortSignal;
  watch?: boolean;
  record?: boolean;
  workingDirectory: string;
};

type AgentMutationRequest = Extract<
  CommandRequest,
  { command: 'agent.add' | 'agent.import' | 'agent.remove' | 'agent.rename' }
>;

type CurlImportRequest = Extract<CommandRequest, { command: 'agent.import'; source_type: 'curl' }>;

const candidateFromLoaded = (
  loaded: Awaited<ReturnType<typeof loadCommandProject>>,
): ProjectResources =>
  structuredClone({
    agents: loaded.agents,
    datasets: loaded.datasets,
    metrics: loaded.metrics,
    project: loaded.project,
    tests: loaded.tests,
  });

const promptRequired = async (
  value: string | undefined,
  label: string,
  path: string,
  interactive: boolean,
  prompt: Prompt | undefined,
  signal?: AbortSignal,
): Promise<string> => {
  if (signal?.aborted === true) throw new AttestCliError('cancelled', 'Command cancelled.');
  if (value?.trim()) return value.trim();
  if (interactive && prompt !== undefined) {
    const answer = (await promptWithSignal(prompt, `${label}: `, signal)).trim();
    if (answer.length > 0) return answer;
  }
  throw new AttestCliError('cli_missing_input', `${label} is required.`, {
    path,
    hint: `Pass ${path} or a complete \`--from-json\` request.`,
  });
};

/** Reads one optional guided value while preserving a documented default. */
const promptDefault = async (
  value: string | undefined,
  question: string,
  fallback: string,
  interactive: boolean,
  prompt: Prompt | undefined,
): Promise<string> => {
  if (value?.trim()) return value.trim();
  if (!interactive || prompt === undefined) return fallback;
  return (await prompt(`${question} [${fallback}]: `)).trim() || fallback;
};

/** Reads one optional guided value, returning undefined for an empty answer. */
const promptOptional = async (
  value: string | undefined,
  question: string,
  interactive: boolean,
  prompt: Prompt | undefined,
): Promise<string | undefined> => {
  if (value?.trim()) return value.trim();
  if (!interactive || prompt === undefined) return undefined;
  const answer = (await prompt(`${question} [none]: `)).trim();
  return answer.length === 0 ? undefined : answer;
};

const commaSeparated = (value: string): string[] | undefined => {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length === 0 ? undefined : entries;
};

/** Makes every guided prompt terminate promptly when the command is cancelled. */
const promptWithSignal = async (
  prompt: Prompt,
  question: string,
  signal?: AbortSignal,
): Promise<string> => {
  if (signal === undefined) return prompt(question);
  if (signal.aborted) throw new AttestCliError('cancelled', 'Command cancelled.');
  return new Promise<string>((resolvePrompt, rejectPrompt) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      action();
    };
    const cancel = (): void =>
      finish(() => rejectPrompt(new AttestCliError('cancelled', 'Command cancelled.')));
    signal.addEventListener('abort', cancel, { once: true });
    // The signal closes the real readline question; the outer race also supports injected prompts.
    void prompt(question, { signal }).then(
      (answer) => finish(() => resolvePrompt(answer)),
      (error: unknown) =>
        finish(() =>
          rejectPrompt(
            signal.aborted || (error instanceof Error && error.name === 'AbortError')
              ? new AttestCliError('cancelled', 'Command cancelled.')
              : error instanceof Error
                ? error
                : new Error('Prompt failed with a non-error rejection.', { cause: error }),
          ),
        ),
    );
  });
};

const assertNoFromJsonFlags = (
  fromJson: string | undefined,
  fields: Readonly<Record<string, unknown>>,
): void => {
  if (fromJson === undefined) return;
  const conflicts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([name]) => name)
    .sort();
  if (conflicts.length === 0) return;
  throw new AttestCliError('cli_usage', 'Command request input overlaps with CLI values.', {
    path: '--from-json',
    hint: 'Pass command values in either the request document or flags, not both.',
    details: { conflicting_fields: conflicts },
  });
};

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

/** Normalizes cURL import flags through the same versioned request schema as --from-json. */
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
    schema: 'attest.command-request/v2',
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

const findAgent = (agents: readonly AgentResource[], id: string): AgentResource => {
  const agent = agents.find((candidate) => candidate.id === id);
  if (agent === undefined) {
    throw new AttestCliError('resource_not_found', `Agent ${id} does not exist.`, {
      path: id,
      hint: 'Run `attest list agents` and retry with an available id.',
    });
  }
  return agent;
};

const mutationResult = async (
  command: string,
  loaded: Awaited<ReturnType<typeof loadCommandProject>>,
  candidate: ProjectResources,
  request: Pick<AgentMutationRequest, 'dry_run' | 'if_project_hash'>,
  publishObserver?: PublishObserver,
  renames?: readonly { from: string; to: string; type: 'agent' }[],
  warnings?: readonly string[],
  confirmation?: {
    definitionPreview?: JsonValue;
    interactive: boolean;
    nextCommand?: string;
    prompt?: Prompt;
    requireExplicit: boolean;
    yes?: boolean;
  },
): Promise<CommandResult> => {
  const apply = (dryRun: boolean, expectedProjectHash = request.if_project_hash) =>
    applyProjectMutation(
      {
        candidate,
        dryRun,
        expectedProjectHash,
        projectRoot: loaded.root,
        renames,
        warnings,
      },
      { publishObserver },
    );
  const preview = await apply(true);
  const operationLines = preview.diff.operations.map((operation) => {
    const renamed = operation.previous_id === undefined ? '' : ` from ${operation.previous_id}`;
    const changes = operation.changes.map(({ path }) => path).join(', ');
    const references = [
      ...operation.references_added.map(({ id }) => `+ref:${id}`),
      ...operation.references_removed.map(({ id }) => `-ref:${id}`),
    ].join(', ');
    const details = [changes, references].filter((value) => value.length > 0).join('; ');
    return `- ${operation.op} ${operation.resource.type} ${operation.resource.id}${renamed}${details.length === 0 ? '' : ` (${details})`}`;
  });
  const warningLines = preview.diff.warnings.map((warning) => `Warning: ${warning}`);
  const previewText = [
    `${command} ${request.dry_run === true ? 'preview' : 'changes'}:`,
    ...(operationLines.length === 0 ? ['- no semantic changes'] : operationLines),
    ...warningLines,
    ...(confirmation?.definitionPreview === undefined
      ? []
      : [`Redacted definition preview: ${JSON.stringify(confirmation.definitionPreview)}`]),
  ].join('\n');
  if (request.dry_run !== true && confirmation?.yes !== true) {
    if (confirmation?.interactive === true && confirmation.prompt !== undefined) {
      const answer = (
        await confirmation.prompt(`${previewText}\nApply these changes? [y/N]: `)
      ).trim();
      if (!/^y(?:es)?$/iu.test(answer)) {
        throw new AttestCliError('cancelled', 'Project mutation was not confirmed.');
      }
    } else if (confirmation?.requireExplicit === true) {
      throw new AttestCliError('cli_usage', 'This destructive mutation requires confirmation.', {
        path: '--yes',
        hint: 'Review `--dry-run --output json`, then pass `--yes` to apply the exact cascade.',
        details: { operations: preview.diff.operations as unknown as JsonValue },
      });
    }
  }
  // Publish only the operation set the caller reviewed; the writer rechecks this under its lock.
  const result = request.dry_run === true ? preview : await apply(false, preview.projectHashBefore);
  const verb = request.dry_run === true ? 'would apply' : 'applied';
  const next =
    request.dry_run === true || confirmation?.nextCommand === undefined
      ? ''
      : `\nNext: ${confirmation.nextCommand}`;
  return {
    human: `${previewText}\n${command} ${verb} ${result.diff.operations.length} operation(s).\nProject hash: ${result.projectHashAfter}${next}`,
    projectHashAfter: result.projectHashAfter,
    projectHashBefore: result.projectHashBefore,
    result: {
      committed: result.committed,
      dry_run: request.dry_run === true,
      operations: result.diff.operations as unknown as JsonValue,
      warnings: result.diff.warnings as unknown as JsonValue,
      ...(confirmation?.definitionPreview === undefined
        ? {}
        : { import_preview: confirmation.definitionPreview }),
      ...(request.dry_run === true || confirmation?.nextCommand === undefined
        ? {}
        : { next_command: confirmation.nextCommand }),
    },
  };
};

/** Adds one native agent resource through the shared transactional project writer. */
const runAgentAddCommand = async (options: AgentAddCommandOptions): Promise<CommandResult> => {
  assertNoFromJsonFlags(options.fromJson, {
    'agent-id': options.agentId,
    'argv-json': options.argvJson,
    env: options.env,
    'header-env': options.headerEnv,
    name: options.name,
    'native-command': options.nativeCommand,
    'native-http': options.nativeHttp,
    timeout: options.timeout,
    trace: options.trace,
    'dry-run': options.dryRun,
    'if-project-hash': options.expectedProjectHash,
    yes: options.yes,
  });
  let request: Extract<CommandRequest, { command: 'agent.add' }>;
  if (options.fromJson !== undefined) {
    request = await readAgentCommandRequest(
      options.fromJson,
      'agent.add',
      options.workingDirectory,
      options.readStdin,
    );
  } else {
    const agentId = await promptRequired(
      options.agentId,
      'Agent id',
      '<agent-id>',
      options.interactive,
      options.prompt,
    );
    let nativeCommand = options.nativeCommand;
    let nativeHttp = options.nativeHttp;
    if (
      options.argvJson === undefined &&
      nativeCommand === undefined &&
      nativeHttp === undefined &&
      options.interactive
    ) {
      const transport = (await options.prompt?.('Transport [cli/http]: '))?.trim().toLowerCase();
      if (transport === 'http') {
        nativeHttp = await promptRequired(
          undefined,
          'Native HTTP URL',
          '--native-http',
          true,
          options.prompt,
        );
      } else if (transport === '' || transport === 'cli' || transport === undefined) {
        nativeCommand = await promptRequired(
          undefined,
          'Native command',
          '--native-command',
          true,
          options.prompt,
        );
      } else {
        throw new AttestCliError('cli_usage', 'Transport must be cli or http.', {
          path: 'transport',
        });
      }
    }
    request = {
      schema: 'attest.command-request/v2',
      command: 'agent.add',
      agent: createAgentResource({
        agentId,
        argvJson: options.argvJson,
        env: options.env,
        headerEnv: options.headerEnv,
        name: options.name,
        nativeCommand,
        nativeHttp,
        timeout: options.timeout,
        trace: options.trace,
      }),
      ...(options.dryRun === undefined ? {} : { dry_run: options.dryRun }),
      ...(options.expectedProjectHash === undefined
        ? {}
        : { if_project_hash: options.expectedProjectHash }),
      ...(options.yes === undefined ? {} : { yes: options.yes }),
    };
  }
  assertSafeNativeAgentResource(request.agent);
  const loaded = await loadCommandProject({
    project: options.project,
    recover: request.dry_run !== true,
    workingDirectory: options.workingDirectory,
  });
  if (loaded.agents.some(({ id }) => id === request.agent.id)) {
    throw new AttestCliError('project_invalid', `Agent ${request.agent.id} already exists.`, {
      path: request.agent.id,
      hint: 'Choose another id or remove the existing agent first.',
    });
  }
  const candidate = candidateFromLoaded(loaded);
  candidate.agents.push(request.agent);
  return mutationResult(
    'agent.add',
    loaded,
    candidate,
    request,
    options.publishObserver,
    undefined,
    undefined,
    {
      interactive: options.interactive,
      nextCommand: `attest agent test ${request.agent.id}`,
      prompt: options.prompt,
      requireExplicit: false,
      yes: request.yes,
    },
  );
};

/** Imports one canonical JSON resource or inert cURL mapping without retaining source contents. */
const runAgentImportCommand = async (
  options: AgentImportCommandOptions,
): Promise<CommandResult> => {
  assertNoFromJsonFlags(options.fromJson, {
    'agent-id': options.agentId,
    'attempt-timeout': options.attemptTimeout,
    'body-timeout': options.bodyTimeout,
    'connect-timeout': options.connectTimeout,
    'error-pointer': options.errorPointer,
    'first-byte-timeout': options.firstByteTimeout,
    'header-env': options.headerEnv,
    'idempotency-header': options.idempotencyHeader,
    'map-body': options.mapBody,
    name: options.name,
    'poll-failure': options.pollFailure,
    'poll-job-id-pointer': options.pollJobIdPointer,
    'poll-maximum-interval': options.pollMaximumInterval,
    'poll-minimum-interval': options.pollMinimumInterval,
    'poll-status-pointer': options.pollStatusPointer,
    'poll-status-url-pointer': options.pollStatusUrlPointer,
    'poll-status-url-template': options.pollStatusUrlTemplate,
    'poll-success': options.pollSuccess,
    'query-env': options.queryEnv,
    'request-cap-bytes': options.requestCapBytes,
    'response-cap-bytes': options.responseCapBytes,
    'response-pointer': options.responsePointer,
    retries: options.retries,
    'retry-delay': options.retryDelay,
    'remote-job-id-pointer': options.remoteJobIdPointer,
    source: options.source,
    'trace-pointer': options.tracePointer,
    type: options.sourceType,
    'dry-run': options.dryRun,
    'if-project-hash': options.expectedProjectHash,
    yes: options.yes,
  });
  let source = options.source;
  let agentId = options.agentId;
  let name = options.name;
  let request: Extract<CommandRequest, { command: 'agent.import' }> | undefined;
  if (options.fromJson !== undefined) {
    request = await readAgentCommandRequest(
      options.fromJson,
      'agent.import',
      options.workingDirectory,
      options.readStdin,
    );
    if (options.fromJson === '-' && request.source === '-') {
      throw new AttestCliError(
        'cli_usage',
        'Command request and agent source cannot share stdin.',
        {
          path: '/source',
          hint: 'Put either the request document or imported resource in a file.',
        },
      );
    }
    source = request.source;
    agentId = request.as;
    name = request.name;
  }
  source = await promptRequired(
    source,
    'Agent import source',
    '<path|url|->',
    options.interactive,
    options.prompt,
  );
  agentId = await promptRequired(
    agentId,
    'Imported agent id',
    '--as',
    options.interactive,
    options.prompt,
  );
  const sourceType =
    request?.source_type ?? options.sourceType ?? (/\.curl$/iu.test(source) ? 'curl' : 'json');
  let agent: AgentResource;
  let importPreview: JsonValue | undefined;
  if (sourceType === 'curl') {
    const curlSource = await readCurlDocument(source, options.workingDirectory, options.readStdin);
    options = await prepareGuidedCurlOptions(options, curlSource);
    const responsePointer =
      request?.source_type === 'curl'
        ? request.extraction.result_pointer
        : options.responsePointer !== undefined
          ? options.responsePointer
          : await promptDefault(
              undefined,
              'Response JSON Pointer',
              '/answer',
              options.interactive,
              options.prompt,
            );
    let curlRequest =
      request?.source_type === 'curl'
        ? request
        : createCurlImportRequest({ agentId, name, options, responsePointer, source });
    const projectRoot = (
      await discoverProject({
        project: options.project,
        workingDirectory: options.workingDirectory,
      })
    ).root;
    let imported: Awaited<ReturnType<typeof createImportedCurlAgentResource>> | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        imported = await createImportedCurlAgentResource(curlRequest, curlSource, projectRoot);
        break;
      } catch (error: unknown) {
        if (
          request !== undefined ||
          !options.interactive ||
          options.prompt === undefined ||
          !(error instanceof AttestCliError) ||
          !/mapping|target/iu.test(error.message) ||
          attempt === 2
        ) {
          throw error;
        }
        options.mapBody = commaSeparated(
          await options.prompt(
            'Body mapping was invalid. Re-enter TARGET_POINTER=INPUT_POINTER values [none]: ',
          ),
        );
        curlRequest = createCurlImportRequest({ agentId, name, options, responsePointer, source });
      }
    }
    if (imported === undefined) throw new Error('Guided cURL import did not settle.');
    agent = imported.agent;
    importPreview = {
      request: imported.preview,
      extraction: curlRequest.extraction,
      ...(curlRequest.polling === undefined ? {} : { polling: curlRequest.polling }),
    };
  } else if (sourceType === 'json') {
    agent = await readImportedAgentResource(
      source,
      agentId,
      name,
      options.workingDirectory,
      options.readStdin,
    );
  } else {
    throw new AttestCliError('cli_usage', 'Agent import type must be json or curl.', {
      path: '--type',
    });
  }
  const loaded = await loadCommandProject({
    project: options.project,
    recover: (request?.dry_run ?? options.dryRun) !== true,
    workingDirectory: options.workingDirectory,
  });
  if (loaded.agents.some(({ id }) => id === agent.id)) {
    throw new AttestCliError('project_invalid', `Agent ${agent.id} already exists.`, {
      path: agent.id,
    });
  }
  const candidate = candidateFromLoaded(loaded);
  candidate.agents.push(agent);
  return mutationResult(
    'agent.import',
    loaded,
    candidate,
    {
      dry_run: request?.dry_run ?? options.dryRun,
      if_project_hash: request?.if_project_hash ?? options.expectedProjectHash,
    },
    options.publishObserver,
    undefined,
    undefined,
    {
      definitionPreview: importPreview,
      interactive: options.interactive,
      nextCommand: `attest agent test ${agent.id}`,
      prompt: options.prompt,
      requireExplicit: false,
      yes: request?.yes ?? options.yes,
    },
  );
};

/** Renames an agent and every test reference in one atomic transaction. */
const runAgentRenameCommand = async (
  options: AgentRenameCommandOptions,
): Promise<CommandResult> => {
  assertNoFromJsonFlags(options.fromJson, {
    'agent-id': options.agentId,
    'new-id': options.newId,
    'dry-run': options.dryRun,
    'if-project-hash': options.expectedProjectHash,
    yes: options.yes,
  });
  const request =
    options.fromJson === undefined
      ? {
          schema: 'attest.command-request/v2' as const,
          command: 'agent.rename' as const,
          agent_id: await promptRequired(
            options.agentId,
            'Agent id',
            '<agent-id>',
            options.interactive,
            options.prompt,
          ),
          new_id: await promptRequired(
            options.newId,
            'New agent id',
            '<new-id>',
            options.interactive,
            options.prompt,
          ),
          ...(options.dryRun === undefined ? {} : { dry_run: options.dryRun }),
          ...(options.expectedProjectHash === undefined
            ? {}
            : { if_project_hash: options.expectedProjectHash }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
        }
      : await readAgentCommandRequest(
          options.fromJson,
          'agent.rename',
          options.workingDirectory,
          options.readStdin,
        );
  const loaded = await loadCommandProject({
    project: options.project,
    recover: request.dry_run !== true,
    workingDirectory: options.workingDirectory,
  });
  const current = findAgent(loaded.agents, request.agent_id);
  if (loaded.agents.some(({ id }) => id === request.new_id)) {
    throw new AttestCliError('project_invalid', `Agent ${request.new_id} already exists.`, {
      path: request.new_id,
    });
  }
  const candidate = candidateFromLoaded(loaded);
  candidate.agents = candidate.agents.map((agent) =>
    agent.id === current.id ? { ...agent, id: request.new_id } : agent,
  );
  candidate.tests = candidate.tests.map((test) =>
    test.agent_id === current.id ? { ...test, agent_id: request.new_id } : test,
  );
  return mutationResult(
    'agent.rename',
    loaded,
    candidate,
    request,
    options.publishObserver,
    [{ from: request.agent_id, to: request.new_id, type: 'agent' }],
    undefined,
    {
      interactive: options.interactive,
      nextCommand: `attest agent test ${request.new_id}`,
      prompt: options.prompt,
      requireExplicit: false,
      yes: request.yes,
    },
  );
};

/** Removes an unreferenced agent, or explicitly cascades dependent tests with --detach. */
const runAgentRemoveCommand = async (
  options: AgentRemoveCommandOptions,
): Promise<CommandResult> => {
  assertNoFromJsonFlags(options.fromJson, {
    'agent-id': options.agentId,
    detach: options.detach,
    'dry-run': options.dryRun,
    'if-project-hash': options.expectedProjectHash,
    yes: options.yes,
  });
  const request =
    options.fromJson === undefined
      ? {
          schema: 'attest.command-request/v2' as const,
          command: 'agent.remove' as const,
          agent_id: await promptRequired(
            options.agentId,
            'Agent id',
            '<agent-id>',
            options.interactive,
            options.prompt,
          ),
          ...(options.detach === undefined ? {} : { detach: options.detach }),
          ...(options.dryRun === undefined ? {} : { dry_run: options.dryRun }),
          ...(options.expectedProjectHash === undefined
            ? {}
            : { if_project_hash: options.expectedProjectHash }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
        }
      : await readAgentCommandRequest(
          options.fromJson,
          'agent.remove',
          options.workingDirectory,
          options.readStdin,
        );
  const loaded = await loadCommandProject({
    project: options.project,
    recover: request.dry_run !== true,
    workingDirectory: options.workingDirectory,
  });
  findAgent(loaded.agents, request.agent_id);
  const dependentTests = loaded.tests.filter(
    ({ agent_id: agentId }) => agentId === request.agent_id,
  );
  if (dependentTests.length > 0 && request.detach !== true) {
    throw new AttestCliError('project_invalid', 'Agent is referenced by tests.', {
      path: request.agent_id,
      hint: 'Rename the reference, remove the dependent tests, or pass `--detach` to cascade them.',
      details: { dependent_test_ids: dependentTests.map(({ id }) => id) },
    });
  }
  const candidate = candidateFromLoaded(loaded);
  candidate.agents = candidate.agents.filter(({ id }) => id !== request.agent_id);
  candidate.tests = candidate.tests.filter(({ agent_id: agentId }) => agentId !== request.agent_id);
  const warnings =
    dependentTests.length === 0
      ? []
      : [`Removed dependent tests: ${dependentTests.map(({ id }) => id).join(', ')}`];
  return mutationResult(
    'agent.remove',
    loaded,
    candidate,
    request,
    options.publishObserver,
    undefined,
    warnings,
    {
      interactive: options.interactive,
      prompt: options.prompt,
      requireExplicit: dependentTests.length > 0,
      yes: request.yes,
    },
  );
};

const readTestInput = async (
  input: string | undefined,
  inputFile: string | undefined,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<JsonValue> => {
  if (input !== undefined && inputFile !== undefined) {
    throw new AttestCliError('cli_usage', 'Agent test input sources overlap.', {
      path: '--input',
      hint: 'Pass either `--input` or `--input-file`, not both.',
    });
  }
  let text = input;
  if (inputFile !== undefined) {
    try {
      text =
        inputFile === '-'
          ? await readStdin()
          : await readFile(resolve(workingDirectory, inputFile), 'utf8');
    } catch (error: unknown) {
      throw new AttestCliError('cli_usage', 'Could not read agent test input.', {
        path: '--input-file',
        cause: error,
      });
    }
  }
  if (text === undefined) return {};
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'Agent test input is not valid JSON.', {
      path: inputFile === undefined ? '--input' : '--input-file',
      hint: 'Pass any valid JSON scalar, array, or object.',
      cause: error,
    });
  }
};

/** Probes one supported adapter without project writes and records one case only when requested. */
const runAgentTestCommand = async (options: AgentTestCommandOptions): Promise<CommandResult> => {
  assertNoFromJsonFlags(options.fromJson, {
    'agent-id': options.agentId,
    input: options.input,
    'input-file': options.inputFile,
    record: options.record,
  });
  if (options.fromJson === '-' && options.inputFile === '-') {
    throw new AttestCliError('cli_usage', 'Command request and test input cannot share stdin.', {
      path: '--input-file',
    });
  }
  const request: { agent_id: string; input: JsonValue; record?: boolean } =
    options.fromJson === undefined
      ? {
          agent_id: await promptRequired(
            options.agentId,
            'Agent id',
            '<agent-id>',
            options.interactive,
            options.prompt,
            options.signal,
          ),
          input: await readTestInput(
            options.input,
            options.inputFile,
            options.workingDirectory,
            options.readStdin,
          ),
        }
      : await readAgentCommandRequest(
          options.fromJson,
          'agent.test',
          options.workingDirectory,
          options.readStdin,
        );
  const loaded = await loadCommandProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });
  const agent = findAgent(loaded.agents, request.agent_id);
  const record = request.record ?? options.record ?? false;
  let store: Awaited<ReturnType<typeof openStore>> | undefined;
  let runId: string | undefined;
  if (record) {
    await mkdir(join(loaded.root, '.attest'), { recursive: true });
    store = await openStore(join(loaded.root, '.attest', 'runs.db'));
    const run = await store.runs.createRun({
      configVersion: 'attest.agent-test/v1',
      configHash: loaded.projectHash,
      configJson: JSON.stringify({ agent_id: agent.id, project_hash: loaded.projectHash }),
      labels: { agent_id: agent.id, kind: 'agent-probe' },
    });
    runId = run.id;
  }
  let result: JsonValue;
  try {
    result = await testNativeAgentConnection({
      agent,
      input: request.input,
      onExecution:
        store === undefined || runId === undefined
          ? undefined
          : (execution) => store.runs.recordCase(runId, execution, []),
      onProgress: options.watch === true ? options.onProgress : undefined,
      projectRoot: loaded.root,
      runId,
      signal: options.signal,
    });
    if (store !== undefined && runId !== undefined) {
      await store.runs.finalizeRun(runId, 'completed');
    }
  } catch (error: unknown) {
    if (store !== undefined && runId !== undefined) {
      await store.runs.finalizeRun(
        runId,
        error instanceof AttestCliError && error.code === 'cancelled' ? 'cancelled' : 'failed',
      );
    }
    throw error;
  } finally {
    await store?.close();
  }
  const resultWithRecord =
    runId === undefined
      ? result
      : ({ ...(result as Record<string, JsonValue>), recorded_run_id: runId } as JsonValue);
  return {
    human: `Agent ${agent.id} passed the connection test.${runId === undefined ? '' : `\nRecorded run: ${runId}`}`,
    projectHashAfter: loaded.projectHash,
    projectHashBefore: loaded.projectHash,
    result: resultWithRecord,
  };
};

export {
  runAgentAddCommand,
  runAgentImportCommand,
  runAgentRemoveCommand,
  runAgentRenameCommand,
  runAgentTestCommand,
  type AgentAddCommandOptions,
  type AgentImportCommandOptions,
  type AgentRemoveCommandOptions,
  type AgentRenameCommandOptions,
  type AgentTestCommandOptions,
};
