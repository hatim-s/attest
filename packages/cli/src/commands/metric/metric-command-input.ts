import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  COMMAND_REQUEST_SCHEMA_VERSION,
  METRIC_RESOURCE_SCHEMA_VERSION,
  assertionCheckSchema,
  commandRequestSchema,
  metricResourceSchema,
  metricTestFixtureSchema,
  type AssertionCheck,
  type CommandRequest,
  type JsonValue,
  type MetricPresetId,
  type MetricResource,
  type MetricTestFixture,
  type SecretReference,
} from '@attest/contracts';

import { AttestCliError } from '../../errors.js';
import { parseArgvJson, parseDuration, type ReadInput } from '../agent/agent-request.js';

type Prompt = (question: string, options?: { signal?: AbortSignal }) => Promise<string>;

type MetricAddFields = {
  argContains?: readonly string[];
  argEquals?: readonly string[];
  argExists?: readonly string[];
  argvJson?: string;
  assertJson?: readonly string[];
  attribute?: readonly string[];
  bodyJson?: string;
  count?: string;
  cwd?: string;
  detailsPointer?: string;
  env?: readonly string[];
  flags?: string;
  gte?: string;
  gt?: string;
  headerEnv?: readonly string[];
  httpMethod?: string;
  jsonSchema?: string;
  jsonSchemaFile?: string;
  lte?: string;
  lt?: string;
  metricId: string;
  model?: string;
  name?: string;
  order?: readonly string[];
  passPointer?: string;
  path?: string;
  pattern?: string;
  preset?: MetricPresetId;
  queryEnv?: readonly string[];
  rationalePointer?: string;
  readStdin: ReadInput;
  rubric?: string;
  rubricFile?: string;
  scorePointer?: string;
  spanKind?: string;
  spanName?: string;
  spanStatus?: string;
  threshold?: string;
  timeout?: string;
  tool?: string;
  toolStatus?: string;
  url?: string;
  value?: string;
  workingDirectory: string;
};

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

const AUTHORED_FIELD_FLAGS: Readonly<Partial<Record<keyof MetricAddFields, string>>> = {
  argContains: '--arg-contains',
  argEquals: '--arg-equals',
  argExists: '--arg-exists',
  argvJson: '--argv-json',
  assertJson: '--assert-json',
  attribute: '--attribute',
  bodyJson: '--body-json',
  count: '--count',
  cwd: '--cwd',
  detailsPointer: '--details-pointer',
  env: '--env',
  flags: '--flags',
  gte: '--gte',
  gt: '--gt',
  headerEnv: '--header-env',
  httpMethod: '--http-method',
  jsonSchema: '--json-schema',
  jsonSchemaFile: '--json-schema-file',
  lte: '--lte',
  lt: '--lt',
  model: '--model',
  order: '--order',
  passPointer: '--pass-pointer',
  path: '--path',
  pattern: '--pattern',
  queryEnv: '--query-env',
  rationalePointer: '--rationale-pointer',
  rubric: '--rubric',
  rubricFile: '--rubric-file',
  scorePointer: '--score-pointer',
  spanKind: '--span-kind',
  spanName: '--span-name',
  spanStatus: '--span-status',
  threshold: '--threshold',
  timeout: '--timeout',
  tool: '--tool',
  toolStatus: '--tool-status',
  url: '--url',
  value: '--value',
};

const requestDiagnostics = (
  issues: readonly { message: string; path: PropertyKey[] }[],
): JsonValue => issues.map(({ message, path }) => ({ message, path: `/${path.join('/')}` }));

/** Rejects every supplied flag that the selected authoring route would otherwise ignore. */
const assertOnlyFields = (
  fields: MetricAddFields,
  allowed: ReadonlySet<keyof MetricAddFields>,
): void => {
  const unsupported = Object.entries(AUTHORED_FIELD_FLAGS)
    .filter(([field]) => {
      const value = fields[field as keyof MetricAddFields];
      return (
        value !== undefined &&
        (!Array.isArray(value) || value.length > 0) &&
        !allowed.has(field as keyof MetricAddFields)
      );
    })
    .map(([, flag]) => flag)
    .sort();
  if (unsupported.length === 0) return;
  throw new AttestCliError(
    'cli_usage',
    'Metric flags do not apply to the selected authoring route.',
    {
      path: unsupported[0],
      hint: 'Remove the incompatible flags or choose the matching preset.',
      details: { incompatible_flags: unsupported },
    },
  );
};

const allowedFields = (
  ...values: Array<keyof MetricAddFields>
): ReadonlySet<keyof MetricAddFields> => new Set(values);

/** Reads one local UTF-8 input without reflecting its potentially sensitive contents. */
const readTextSource = async (
  source: string,
  path: string,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<string> => {
  try {
    return source === '-'
      ? await readStdin()
      : await readFile(resolve(workingDirectory, source), 'utf8');
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'Could not read the requested metric input.', {
      path,
      hint: 'Pass a readable UTF-8 file or `-` for stdin.',
      cause: error,
    });
  }
};

const parseJson = (text: string, path: string, hint: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', `${path} is not valid JSON.`, {
      path,
      hint,
      cause: error,
    });
  }
};

/** Validates a request from flags or `--from-json` through the same strict published union. */
const validateMetricCommandRequest = <TCommand extends CommandRequest['command']>(
  command: TCommand,
  value: unknown,
): Extract<CommandRequest, { command: TCommand }> => {
  const parsed = commandRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'The metric command request does not match its schema.', {
      hint: `Run \`attest help ${command.replaceAll('.', ' ')} --output json\` and repair the input.`,
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  if (parsed.data.command !== command) {
    throw new AttestCliError('cli_usage', 'The command request targets another command.', {
      path: '/command',
      hint: `Set \`command\` to \`${command}\`.`,
    });
  }
  return parsed.data as Extract<CommandRequest, { command: TCommand }>;
};

/** Reads one strict metric command request without allowing a second stdin consumer. */
const readMetricCommandRequest = async <TCommand extends CommandRequest['command']>(
  command: TCommand,
  source: string,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<Extract<CommandRequest, { command: TCommand }>> => {
  const text = await readTextSource(source, '--from-json', workingDirectory, readStdin);
  return validateMetricCommandRequest(
    command,
    parseJson(text, '--from-json', `Provide one ${COMMAND_REQUEST_SCHEMA_VERSION} document.`),
  );
};

const parseFiniteNumber = (value: string, path: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AttestCliError('cli_usage', `${path} must be a finite number.`, { path });
  }
  return parsed;
};

const parseNonnegativeInteger = (value: string, path: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AttestCliError('cli_usage', `${path} must be a non-negative integer.`, { path });
  }
  return parsed;
};

const parseJsonValue = (value: string, path: string): JsonValue =>
  parseJson(value, path, 'Pass one JSON scalar, array, or object.') as JsonValue;

const parseSecretBindings = (
  values: readonly string[] | undefined,
  path: string,
): Record<string, SecretReference> | undefined => {
  if (values === undefined || values.length === 0) return undefined;
  const bindings: Record<string, SecretReference> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    const target = value.slice(0, separator).trim();
    const source = value.slice(separator + 1).trim();
    if (separator <= 0 || target.length === 0 || source.length === 0) {
      throw new AttestCliError('cli_usage', `Invalid secret reference in ${path}.`, {
        path,
        hint: 'Use TARGET_NAME=SOURCE_ENV; only the environment variable name is stored.',
      });
    }
    bindings[target] = { from_env: source };
  }
  return bindings;
};

const parsePathValueMatchers = (
  values: readonly string[] | undefined,
  operator: 'contains' | 'equals',
  path: string,
): AssertionCheck[] =>
  (values ?? []).map((entry) => {
    const separator = entry.indexOf('=');
    const matcherPath = entry.slice(0, separator).trim();
    if (separator <= 0 || matcherPath.length === 0) {
      throw new AttestCliError('cli_usage', `Invalid matcher in ${path}.`, {
        path,
        hint: `Use '$.path=<json>' for ${operator} matchers.`,
      });
    }
    const value = parseJsonValue(entry.slice(separator + 1), path);
    return operator === 'equals'
      ? { equals: { path: matcherPath, value } }
      : { contains: { path: matcherPath, value } };
  });

const parseAttributes = (
  values: readonly string[] | undefined,
): Record<string, string | number | boolean> | undefined => {
  if (values === undefined || values.length === 0) return undefined;
  const attributes: Record<string, string | number | boolean> = {};
  for (const entry of values) {
    const separator = entry.indexOf('=');
    const name = entry.slice(0, separator).trim();
    const parsed =
      separator <= 0 ? undefined : parseJsonValue(entry.slice(separator + 1), '--attribute');
    if (
      name.length === 0 ||
      parsed === undefined ||
      (typeof parsed !== 'string' && typeof parsed !== 'number' && typeof parsed !== 'boolean')
    ) {
      throw new AttestCliError('cli_usage', 'Span attributes must use NAME=<json-primitive>.', {
        path: '--attribute',
      });
    }
    attributes[name] = parsed;
  }
  return attributes;
};

const parseAssertionJson = (values: readonly string[]): AssertionCheck[] =>
  values.map((value, index) => {
    const parsed = assertionCheckSchema.safeParse(
      parseJson(value, '--assert-json', 'Pass one assertion check object.'),
    );
    if (!parsed.success) {
      throw new AttestCliError('cli_usage', 'An assertion does not match the metric contract.', {
        path: `--assert-json[${index}]`,
        details: { diagnostics: requestDiagnostics(parsed.error.issues) },
      });
    }
    return parsed.data;
  });

const requireValue = (value: string | undefined, path: string): string => {
  if (value?.trim()) return value.trim();
  throw new AttestCliError('cli_missing_input', `Required metric input ${path} is missing.`, {
    path,
    hint: `Pass ${path}, use the guided wizard, or provide a complete --from-json request.`,
  });
};

const readExclusiveText = async (
  literal: string | undefined,
  source: string | undefined,
  literalPath: string,
  sourcePath: string,
  fields: MetricAddFields,
): Promise<string> => {
  if (literal !== undefined && source !== undefined) {
    throw new AttestCliError('cli_usage', 'Metric text input sources overlap.', {
      path: literalPath,
      hint: `Pass either ${literalPath} or ${sourcePath}.`,
    });
  }
  if (literal?.trim()) return literal.trim();
  if (source !== undefined) {
    const text = await readTextSource(
      source,
      sourcePath,
      fields.workingDirectory,
      fields.readStdin,
    );
    if (text.trim()) return text;
  }
  throw new AttestCliError(
    'cli_missing_input',
    `Required metric input ${literalPath} is missing.`,
    {
      path: literalPath,
      hint: `Pass ${literalPath} or ${sourcePath}.`,
    },
  );
};

const buildAssertionDefinition = async (
  fields: MetricAddFields,
): Promise<MetricResource['definition']> => {
  const path = fields.path ?? '$.output';
  switch (fields.preset) {
    case 'output-equals':
      return {
        kind: 'assertion',
        assertions: [
          {
            equals: {
              path,
              value: parseJsonValue(requireValue(fields.value, '--value'), '--value'),
            },
          },
        ],
      };
    case 'output-contains':
      return {
        kind: 'assertion',
        assertions: [
          {
            contains: {
              path,
              value: parseJsonValue(requireValue(fields.value, '--value'), '--value'),
            },
          },
        ],
      };
    case 'output-schema': {
      const schemaText = await readExclusiveText(
        fields.jsonSchema,
        fields.jsonSchemaFile,
        '--json-schema',
        '--json-schema-file',
        fields,
      );
      return {
        kind: 'assertion',
        assertions: [
          {
            json_schema: {
              path,
              schema: parseJson(
                schemaText,
                '--json-schema',
                'Pass a JSON Schema object or boolean.',
              ) as never,
            },
          },
        ],
      };
    }
    case 'tool-called': {
      const argumentsList: AssertionCheck[] = [
        ...parsePathValueMatchers(fields.argEquals, 'equals', '--arg-equals'),
        ...parsePathValueMatchers(fields.argContains, 'contains', '--arg-contains'),
        ...(fields.argExists ?? []).map((argumentPath) => ({ exists: { path: argumentPath } })),
      ];
      return {
        kind: 'assertion',
        assertions: [
          {
            tool_calls: {
              name: requireValue(fields.tool, '--tool'),
              ...(fields.toolStatus === undefined
                ? {}
                : { status: fields.toolStatus as 'error' | 'ok' }),
              ...(fields.count === undefined
                ? {}
                : { count: parseNonnegativeInteger(fields.count, '--count') }),
              ...(argumentsList.length === 0 ? {} : { arguments: argumentsList as never }),
            },
          },
        ],
      };
    }
    case 'tool-order':
      if (fields.order === undefined || fields.order.length === 0) {
        throw new AttestCliError(
          'cli_missing_input',
          'Tool order requires at least one --order value.',
          {
            path: '--order',
          },
        );
      }
      return { kind: 'assertion', assertions: [{ tool_calls: { order: [...fields.order] } }] };
    case 'no-tool-errors':
      return {
        kind: 'assertion',
        assertions: [{ spans: { filter: { kind: 'tool', status: 'error' }, count: 0 } }],
      };
    case 'trace-span': {
      const attributes = parseAttributes(fields.attribute);
      const filter = {
        ...(fields.spanKind === undefined ? {} : { kind: fields.spanKind as 'agent' }),
        ...(fields.spanName === undefined ? {} : { name: fields.spanName }),
        ...(fields.spanStatus === undefined ? {} : { status: fields.spanStatus as 'error' | 'ok' }),
        ...(attributes === undefined ? {} : { attributes }),
      };
      return {
        kind: 'assertion',
        assertions: [
          {
            spans: {
              ...(Object.keys(filter).length === 0 ? {} : { filter }),
              ...(fields.count === undefined
                ? { count: 1 }
                : { count: parseNonnegativeInteger(fields.count, '--count') }),
              ...(fields.order === undefined ? {} : { order: [...fields.order] }),
            },
          },
        ],
      };
    }
    default:
      throw new AttestCliError('cli_usage', 'The selected preset is not an assertion preset.', {
        path: '--preset',
      });
  }
};

/** Builds one strict canonical metric resource from every flag and guided-input route. */
const createMetricResource = async (fields: MetricAddFields): Promise<MetricResource> => {
  let definition: MetricResource['definition'];
  if (fields.assertJson !== undefined && fields.assertJson.length > 0) {
    if (fields.preset !== undefined) {
      throw new AttestCliError('cli_usage', '--assert-json cannot be combined with --preset.', {
        path: '--assert-json',
      });
    }
    assertOnlyFields(fields, allowedFields('assertJson'));
    definition = { kind: 'assertion', assertions: parseAssertionJson(fields.assertJson) };
  } else if (fields.preset === 'judge-rubric') {
    assertOnlyFields(fields, allowedFields('model', 'preset', 'rubric', 'rubricFile', 'threshold'));
    definition = {
      kind: 'judge',
      model: requireValue(fields.model, '--model'),
      rubric: await readExclusiveText(
        fields.rubric,
        fields.rubricFile,
        '--rubric',
        '--rubric-file',
        fields,
      ),
      threshold:
        fields.threshold === undefined ? 0.8 : parseFiniteNumber(fields.threshold, '--threshold'),
    };
  } else if (fields.preset === 'command') {
    assertOnlyFields(fields, allowedFields('argvJson', 'cwd', 'env', 'preset', 'timeout'));
    definition = {
      kind: 'exec',
      argv: parseArgvJson(requireValue(fields.argvJson, '--argv-json')),
      ...(fields.cwd === undefined ? {} : { cwd: fields.cwd }),
      ...(parseSecretBindings(fields.env, '--env') === undefined
        ? {}
        : { env: parseSecretBindings(fields.env, '--env') }),
      ...(fields.timeout === undefined ? {} : { timeout_ms: parseDuration(fields.timeout) }),
    };
  } else if (fields.preset === 'http') {
    assertOnlyFields(
      fields,
      allowedFields(
        'bodyJson',
        'detailsPointer',
        'headerEnv',
        'httpMethod',
        'passPointer',
        'preset',
        'queryEnv',
        'rationalePointer',
        'scorePointer',
        'timeout',
        'url',
      ),
    );
    definition = {
      kind: 'http',
      request: {
        url: requireValue(fields.url, '--url'),
        method: (fields.httpMethod ?? 'POST') as 'POST',
        ...(parseSecretBindings(fields.headerEnv, '--header-env') === undefined
          ? {}
          : { headers: parseSecretBindings(fields.headerEnv, '--header-env') }),
        ...(parseSecretBindings(fields.queryEnv, '--query-env') === undefined
          ? {}
          : { query: parseSecretBindings(fields.queryEnv, '--query-env') }),
        ...(fields.bodyJson === undefined
          ? {}
          : { body: parseJsonValue(fields.bodyJson, '--body-json') }),
      },
      extraction: {
        score_pointer: fields.scorePointer ?? '/score',
        pass_pointer: fields.passPointer ?? '/pass',
        ...(fields.rationalePointer === undefined
          ? {}
          : { rationale_pointer: fields.rationalePointer }),
        ...(fields.detailsPointer === undefined ? {} : { details_pointer: fields.detailsPointer }),
      },
      ...(fields.timeout === undefined ? {} : { timeout_ms: parseDuration(fields.timeout) }),
    };
  } else if (fields.preset !== undefined) {
    const presetFields: Record<
      Exclude<MetricPresetId, 'command' | 'http' | 'judge-rubric'>,
      ReadonlySet<keyof MetricAddFields>
    > = {
      'output-equals': allowedFields('path', 'preset', 'value'),
      'output-contains': allowedFields('path', 'preset', 'value'),
      'output-schema': allowedFields('jsonSchema', 'jsonSchemaFile', 'path', 'preset'),
      'tool-called': allowedFields(
        'argContains',
        'argEquals',
        'argExists',
        'count',
        'preset',
        'tool',
        'toolStatus',
      ),
      'tool-order': allowedFields('order', 'preset'),
      'no-tool-errors': allowedFields('preset'),
      'trace-span': allowedFields(
        'attribute',
        'count',
        'order',
        'preset',
        'spanKind',
        'spanName',
        'spanStatus',
      ),
    };
    assertOnlyFields(fields, presetFields[fields.preset]);
    definition = await buildAssertionDefinition(fields);
  } else {
    const thresholds = [fields.lt, fields.lte, fields.gt, fields.gte].filter(
      (value) => value !== undefined,
    );
    if (thresholds.length > 0) {
      assertOnlyFields(fields, allowedFields('gt', 'gte', 'lt', 'lte', 'path'));
      definition = {
        kind: 'assertion',
        assertions: [
          {
            threshold: {
              path: fields.path ?? '$.output',
              ...(fields.lt === undefined ? {} : { lt: parseFiniteNumber(fields.lt, '--lt') }),
              ...(fields.lte === undefined ? {} : { lte: parseFiniteNumber(fields.lte, '--lte') }),
              ...(fields.gt === undefined ? {} : { gt: parseFiniteNumber(fields.gt, '--gt') }),
              ...(fields.gte === undefined ? {} : { gte: parseFiniteNumber(fields.gte, '--gte') }),
            },
          },
        ],
      };
    } else if (fields.pattern !== undefined) {
      assertOnlyFields(fields, allowedFields('flags', 'path', 'pattern'));
      definition = {
        kind: 'assertion',
        assertions: [
          {
            regex: {
              path: fields.path ?? '$.output',
              pattern: fields.pattern,
              ...(fields.flags === undefined ? {} : { flags: fields.flags }),
            },
          },
        ],
      };
    } else if (fields.path !== undefined) {
      assertOnlyFields(fields, allowedFields('path'));
      definition = { kind: 'assertion', assertions: [{ exists: { path: fields.path } }] };
    } else {
      throw new AttestCliError('cli_missing_input', 'A metric preset or assertion is required.', {
        path: '--preset',
        hint: 'Pass --preset, --assert-json, --pattern, a threshold flag, or --path for exists.',
      });
    }
  }

  const parsed = metricResourceSchema.safeParse({
    schema: METRIC_RESOURCE_SCHEMA_VERSION,
    id: fields.metricId,
    name: fields.name?.trim() || fields.metricId,
    definition,
  });
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'Metric values do not match the v2 resource schema.', {
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  assertSafeMetricResource(parsed.data);
  return parsed.data;
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

/** Imports either one canonical metric resource or the metric inside a versioned add request. */
const readImportedMetricResource = async (
  source: string,
  metricId: string,
  name: string | undefined,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<MetricResource> => {
  const value = parseJson(
    await readTextSource(source, '<path|->', workingDirectory, readStdin),
    '<path|->',
    'Provide one canonical metric resource or metric.add request.',
  );
  const request = commandRequestSchema.safeParse(value);
  const candidate =
    request.success && request.data.command === 'metric.add' ? request.data.metric : value;
  const parsed = metricResourceSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'Imported metric JSON does not match its schema.', {
      path: '<path|->',
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  const resource = { ...parsed.data, id: metricId, name: name?.trim() || parsed.data.name };
  assertSafeMetricResource(resource);
  return resource;
};

/** Reads and validates one complete local fixture before any metric process can start. */
const readMetricTestFixture = async (
  source: string,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<MetricTestFixture> => {
  const value = parseJson(
    await readTextSource(source, '--fixture', workingDirectory, readStdin),
    '--fixture',
    'Provide one attest.metric-test-fixture/v1 document.',
  );
  const parsed = metricTestFixtureSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError(
      'project_invalid',
      'The local metric fixture does not match its schema.',
      {
        path: '--fixture',
        details: { diagnostics: requestDiagnostics(parsed.error.issues) },
      },
    );
  }
  return parsed.data;
};

export {
  assertSafeMetricResource,
  createMetricResource,
  readImportedMetricResource,
  readMetricCommandRequest,
  readMetricTestFixture,
  validateMetricCommandRequest,
  type MetricAddFields,
  type Prompt,
};
