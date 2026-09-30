import {
  METRIC_RESOURCE_SCHEMA_ID,
  metricResourceSchema,
  type MetricPresetId,
  type MetricResource,
  type ToolArgumentMatcher,
} from '@attest/contracts';
import { z } from 'zod';

import { LocalError } from '../../../errors/index.js';
import { schemaIssueDiagnostics } from '../../../internal/schema-issue-diagnostics.js';
import { parseJsonText } from '../../../internal/source-text.js';
import { parseArgvJson, parseDuration } from '../../agent/authoring/input-parsers.js';
import {
  parseAssertionJson,
  parseAttributes,
  parseChoice,
  parseFiniteNumber,
  parseJsonValue,
  parseNonnegativeInteger,
  parsePathValueMatchers,
  parseOptionalSecretBindings,
  readExclusiveText,
  requireValue,
} from './value-parsers.js';
import type { MetricAddFields } from './types.js';
import { assertSafeMetricResource } from './validation.js';

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

const jsonSchemaSchema = z.union([z.boolean(), z.record(z.string(), z.json())]);

const parseJsonSchema = (value: string): z.infer<typeof jsonSchemaSchema> => {
  const parsed = jsonSchemaSchema.safeParse(
    parseJsonText(value, { path: '--json-schema', hint: 'Pass a JSON Schema object or boolean.' }),
  );
  if (!parsed.success) {
    throw new LocalError('cli_usage', 'JSON Schema must be an object or boolean.', {
      path: '--json-schema',
      details: { diagnostics: schemaIssueDiagnostics(parsed.error.issues) },
    });
  }
  return parsed.data;
};

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
  throw new LocalError('cli_usage', 'Metric flags do not apply to the selected authoring route.', {
    path: unsupported[0],
    hint: 'Remove the incompatible flags or choose the matching preset.',
    details: { incompatible_flags: unsupported },
  });
};

const allowedFields = (
  ...values: Array<keyof MetricAddFields>
): ReadonlySet<keyof MetricAddFields> => new Set(values);

const SPAN_KINDS = ['agent', 'llm', 'tool', 'retrieval', 'other'] as const;
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const ASSERTION_PRESET_FIELDS: Readonly<
  Record<
    Exclude<MetricPresetId, 'command' | 'http' | 'judge-rubric'>,
    ReadonlySet<keyof MetricAddFields>
  >
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
              schema: parseJsonSchema(schemaText),
            },
          },
        ],
      };
    }
    case 'tool-called': {
      const argumentsList: ToolArgumentMatcher[] = [
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
                : { status: parseChoice(fields.toolStatus, ['ok', 'error'], '--tool-status') }),
              ...(fields.count === undefined
                ? {}
                : { count: parseNonnegativeInteger(fields.count, '--count') }),
              ...(argumentsList.length === 0 ? {} : { arguments: argumentsList }),
            },
          },
        ],
      };
    }
    case 'tool-order':
      if (fields.order === undefined || fields.order.length === 0) {
        throw new LocalError(
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
        ...(fields.spanKind === undefined
          ? {}
          : { kind: parseChoice(fields.spanKind, SPAN_KINDS, '--span-kind') }),
        ...(fields.spanName === undefined ? {} : { name: fields.spanName }),
        ...(fields.spanStatus === undefined
          ? {}
          : { status: parseChoice(fields.spanStatus, ['ok', 'error'], '--span-status') }),
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
      throw new LocalError('cli_usage', 'The selected preset is not an assertion preset.', {
        path: '--preset',
      });
  }
};

/** Builds one strict canonical metric resource from every flag and guided-input route. */
const createMetricResource = async (fields: MetricAddFields): Promise<MetricResource> => {
  let definition: MetricResource['definition'];
  if (fields.assertJson !== undefined && fields.assertJson.length > 0) {
    if (fields.preset !== undefined) {
      throw new LocalError('cli_usage', '--assert-json cannot be combined with --preset.', {
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
    const env = parseOptionalSecretBindings(fields.env, '--env');
    definition = {
      kind: 'exec',
      argv: parseArgvJson(requireValue(fields.argvJson, '--argv-json')),
      ...(fields.cwd === undefined ? {} : { cwd: fields.cwd }),
      ...(env === undefined ? {} : { env }),
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
    const headers = parseOptionalSecretBindings(fields.headerEnv, '--header-env');
    const query = parseOptionalSecretBindings(fields.queryEnv, '--query-env');
    definition = {
      kind: 'http',
      request: {
        url: requireValue(fields.url, '--url'),
        method: parseChoice(fields.httpMethod ?? 'POST', HTTP_METHODS, '--http-method'),
        ...(headers === undefined ? {} : { headers }),
        ...(query === undefined ? {} : { query }),
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
    assertOnlyFields(fields, ASSERTION_PRESET_FIELDS[fields.preset]);
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
      throw new LocalError('cli_missing_input', 'A metric preset or assertion is required.', {
        path: '--preset',
        hint: 'Pass --preset, --assert-json, --pattern, a threshold flag, or --path for exists.',
      });
    }
  }

  const parsed = metricResourceSchema.safeParse({
    schema: METRIC_RESOURCE_SCHEMA_ID,
    id: fields.metricId,
    name: fields.name?.trim() || fields.metricId,
    definition,
  });
  if (!parsed.success) {
    throw new LocalError('cli_usage', 'Metric values do not match the resource schema.', {
      details: { diagnostics: schemaIssueDiagnostics(parsed.error.issues) },
    });
  }
  assertSafeMetricResource(parsed.data);
  return parsed.data;
};

export { createMetricResource };
