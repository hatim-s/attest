import * as Effect from 'effect/Effect';
import {
  parseWithSchema,
  METRIC_RESOURCE_SCHEMA_ID,
  metricResourceSchema,
  type LeafAssertionCheck,
  type SpanFilter,
  type MetricPresetId,
  type MetricResource,
  type ToolArgumentMatcher,
} from '@attest/contracts';
import * as Schema from 'effect/Schema';

import { LocalError } from '../../../errors/index.js';
import { schemaIssueDiagnostics } from '../../../internal/schema-issue-diagnostics.js';
import { parseJsonText } from '../../../internal/source-text.js';
import { parseArgvJson, parseDuration } from '../../shared/authoring-parsing.js';
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

const jsonSchemaSchema = Schema.Union([Schema.Boolean, Schema.Record(Schema.String, Schema.Json)]);

const parseJsonSchema = Effect.fn('parseJsonSchema')(function* (value: string) {
  const parsed = parseWithSchema(
    jsonSchemaSchema,
    yield* parseJsonText(value, {
      path: '--json-schema',
      hint: 'Pass a JSON Schema object or boolean.',
    }),
  );

  if (!parsed.ok) {
    return yield* new LocalError('cli_usage', 'JSON Schema must be an object or boolean.', {
      path: '--json-schema',
      details: { diagnostics: schemaIssueDiagnostics(parsed.error.issues) },
    });
  }

  return parsed.value;
});

/** Rejects every supplied flag that the selected authoring route would otherwise ignore. */
const assertOnlyFields = Effect.fn('assertOnlyFields')(function* (
  fields: MetricAddFields,
  allowed: ReadonlySet<keyof MetricAddFields>,
) {
  const unsupported: string[] = [];

  for (const [field, flag] of Object.entries(AUTHORED_FIELD_FLAGS)) {
    // SAFETY: AUTHORED_FIELD_FLAGS contains only keys declared by MetricAddFields.
    const authoredField = field as keyof MetricAddFields;
    const value = fields[authoredField];

    if (
      value !== undefined &&
      (!Array.isArray(value) || value.length > 0) &&
      !allowed.has(authoredField)
    ) {
      unsupported.push(flag);
    }
  }

  unsupported.sort();

  if (unsupported.length === 0) return;

  return yield* new LocalError(
    'cli_usage',
    'Metric flags do not apply to the selected authoring route.',
    {
      path: unsupported[0],
      hint: 'Remove the incompatible flags or choose the matching preset.',
      details: { incompatible_flags: unsupported },
    },
  );
});

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

const buildAssertionDefinition = Effect.fn('buildAssertionDefinition')(function* (
  fields: MetricAddFields,
) {
  const path = fields.path ?? '$.output';

  switch (fields.preset) {
    case 'output-equals':
      return {
        kind: 'assertion' as const,
        assertions: [
          {
            equals: {
              path,
              value: yield* parseJsonValue(yield* requireValue(fields.value, '--value'), '--value'),
            },
          },
        ],
      } satisfies MetricResource['definition'];
    case 'output-contains':
      return {
        kind: 'assertion' as const,
        assertions: [
          {
            contains: {
              path,
              value: yield* parseJsonValue(yield* requireValue(fields.value, '--value'), '--value'),
            },
          },
        ],
      } satisfies MetricResource['definition'];
    case 'output-schema': {
      const schemaText = yield* readExclusiveText(
        fields.jsonSchema,
        fields.jsonSchemaFile,
        '--json-schema',
        '--json-schema-file',
        fields,
      );

      return {
        kind: 'assertion' as const,
        assertions: [
          {
            json_schema: {
              path,
              schema: yield* parseJsonSchema(schemaText),
            },
          },
        ],
      } satisfies MetricResource['definition'];
    }

    case 'tool-called': {
      const argumentsList: ToolArgumentMatcher[] = [
        ...(yield* parsePathValueMatchers(fields.argEquals, 'equals', '--arg-equals')),
        ...(yield* parsePathValueMatchers(fields.argContains, 'contains', '--arg-contains')),
        ...(fields.argExists ?? []).map((argumentPath) => ({ exists: { path: argumentPath } })),
      ];

      let toolCalls: Extract<LeafAssertionCheck, { tool_calls: object }>['tool_calls'] = {
        name: yield* requireValue(fields.tool, '--tool'),
      };

      if (fields.toolStatus !== undefined)
        toolCalls = {
          ...toolCalls,
          status: yield* parseChoice(fields.toolStatus, ['ok', 'error'], '--tool-status'),
        };

      if (fields.count !== undefined)
        toolCalls = {
          ...toolCalls,
          count: yield* parseNonnegativeInteger(fields.count, '--count'),
        };

      if (argumentsList.length > 0) toolCalls = { ...toolCalls, arguments: argumentsList };

      return {
        kind: 'assertion' as const,
        assertions: [{ tool_calls: toolCalls }],
      } satisfies MetricResource['definition'];
    }

    case 'tool-order':
      if (fields.order === undefined || fields.order.length === 0) {
        return yield* new LocalError(
          'cli_missing_input',
          'Tool order requires at least one --order value.',
          {
            path: '--order',
          },
        );
      }

      return {
        kind: 'assertion' as const,
        assertions: [{ tool_calls: { order: [...fields.order] } }],
      } satisfies MetricResource['definition'];
    case 'no-tool-errors':
      return {
        kind: 'assertion' as const,
        assertions: [
          { spans: { filter: { kind: 'tool' as const, status: 'error' as const }, count: 0 } },
        ],
      } satisfies MetricResource['definition'];
    case 'trace-span': {
      const attributes = yield* parseAttributes(fields.attribute);

      let filter: SpanFilter = {};

      if (fields.spanKind !== undefined)
        filter = {
          ...filter,
          kind: yield* parseChoice(fields.spanKind, SPAN_KINDS, '--span-kind'),
        };

      if (fields.spanName !== undefined) filter = { ...filter, name: fields.spanName };

      if (fields.spanStatus !== undefined)
        filter = {
          ...filter,
          status: yield* parseChoice(fields.spanStatus, ['ok', 'error'], '--span-status'),
        };

      if (attributes !== undefined) filter = { ...filter, attributes: attributes };

      let spans: Extract<LeafAssertionCheck, { spans: object }>['spans'] = {
        count:
          fields.count === undefined ? 1 : yield* parseNonnegativeInteger(fields.count, '--count'),
      };

      if (Object.keys(filter).length > 0) spans = { ...spans, filter: filter };

      if (fields.order !== undefined) spans = { ...spans, order: [...fields.order] };

      return {
        kind: 'assertion' as const,
        assertions: [{ spans }],
      } satisfies MetricResource['definition'];
    }

    default:
      return yield* new LocalError('cli_usage', 'The selected preset is not an assertion preset.', {
        path: '--preset',
      });
  }
});

/** Builds one strict canonical metric resource from every flag and guided-input route. */
const createMetricResource = Effect.fn('createMetricResource')(function* (fields: MetricAddFields) {
  let definition: MetricResource['definition'];

  if (fields.assertJson !== undefined && fields.assertJson.length > 0) {
    if (fields.preset !== undefined) {
      return yield* new LocalError('cli_usage', '--assert-json cannot be combined with --preset.', {
        path: '--assert-json',
      });
    }

    yield* assertOnlyFields(fields, allowedFields('assertJson'));
    definition = {
      kind: 'assertion' as const,
      assertions: yield* parseAssertionJson(fields.assertJson),
    };
  } else if (fields.preset === 'judge-rubric') {
    yield* assertOnlyFields(
      fields,
      allowedFields('model', 'preset', 'rubric', 'rubricFile', 'threshold'),
    );
    definition = {
      kind: 'judge' as const,
      model: yield* requireValue(fields.model, '--model'),
      rubric: yield* readExclusiveText(
        fields.rubric,
        fields.rubricFile,
        '--rubric',
        '--rubric-file',
        fields,
      ),
      threshold:
        fields.threshold === undefined
          ? 0.8
          : yield* parseFiniteNumber(fields.threshold, '--threshold'),
    };
  } else if (fields.preset === 'command') {
    yield* assertOnlyFields(fields, allowedFields('argvJson', 'cwd', 'env', 'preset', 'timeout'));
    const env = yield* parseOptionalSecretBindings(fields.env, '--env');
    definition = {
      kind: 'exec' as const,
      argv: yield* parseArgvJson(yield* requireValue(fields.argvJson, '--argv-json')),
    };

    if (fields.cwd !== undefined) definition = { ...definition, cwd: fields.cwd };

    if (env !== undefined) definition = { ...definition, env: env };

    if (fields.timeout !== undefined)
      definition = { ...definition, timeout_ms: yield* parseDuration(fields.timeout, '--timeout') };
  } else if (fields.preset === 'http') {
    yield* assertOnlyFields(
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
    const headers = yield* parseOptionalSecretBindings(fields.headerEnv, '--header-env');
    const query = yield* parseOptionalSecretBindings(fields.queryEnv, '--query-env');
    definition = {
      kind: 'http' as const,
      request: {
        url: yield* requireValue(fields.url, '--url'),
        method: yield* parseChoice(fields.httpMethod ?? 'POST', HTTP_METHODS, '--http-method'),
      },
      extraction: {
        score_pointer: fields.scorePointer ?? '/score',
        pass_pointer: fields.passPointer ?? '/pass',
      },
    };

    if (headers !== undefined)
      definition = { ...definition, request: { ...definition.request, headers: headers } };

    if (query !== undefined)
      definition = { ...definition, request: { ...definition.request, query: query } };

    if (fields.bodyJson !== undefined)
      definition = {
        ...definition,
        request: {
          ...definition.request,
          body: yield* parseJsonValue(fields.bodyJson, '--body-json'),
        },
      };

    if (fields.rationalePointer !== undefined)
      definition = {
        ...definition,
        extraction: { ...definition.extraction, rationale_pointer: fields.rationalePointer },
      };

    if (fields.detailsPointer !== undefined)
      definition = {
        ...definition,
        extraction: { ...definition.extraction, details_pointer: fields.detailsPointer },
      };

    if (fields.timeout !== undefined)
      definition = { ...definition, timeout_ms: yield* parseDuration(fields.timeout, '--timeout') };
  } else if (fields.preset !== undefined) {
    yield* assertOnlyFields(fields, ASSERTION_PRESET_FIELDS[fields.preset]);
    definition = yield* buildAssertionDefinition(fields);
  } else {
    const thresholds = [fields.lt, fields.lte, fields.gt, fields.gte].filter(
      (value) => value !== undefined,
    );

    if (thresholds.length > 0) {
      yield* assertOnlyFields(fields, allowedFields('gt', 'gte', 'lt', 'lte', 'path'));

      let threshold: Extract<LeafAssertionCheck, { threshold: object }>['threshold'] = {
        path: fields.path ?? '$.output',
      };

      if (fields.lt !== undefined)
        threshold = { ...threshold, lt: yield* parseFiniteNumber(fields.lt, '--lt') };

      if (fields.lte !== undefined)
        threshold = { ...threshold, lte: yield* parseFiniteNumber(fields.lte, '--lte') };

      if (fields.gt !== undefined)
        threshold = { ...threshold, gt: yield* parseFiniteNumber(fields.gt, '--gt') };

      if (fields.gte !== undefined)
        threshold = { ...threshold, gte: yield* parseFiniteNumber(fields.gte, '--gte') };
      definition = { kind: 'assertion' as const, assertions: [{ threshold }] };
    } else if (fields.pattern !== undefined) {
      yield* assertOnlyFields(fields, allowedFields('flags', 'path', 'pattern'));

      let regex: Extract<LeafAssertionCheck, { regex: object }>['regex'] = {
        path: fields.path ?? '$.output',
        pattern: fields.pattern,
      };

      if (fields.flags !== undefined) regex = { ...regex, flags: fields.flags };
      definition = { kind: 'assertion' as const, assertions: [{ regex }] };
    } else if (fields.path !== undefined) {
      yield* assertOnlyFields(fields, allowedFields('path'));
      definition = {
        kind: 'assertion' as const,
        assertions: [{ exists: { path: fields.path } }],
      };
    } else {
      return yield* new LocalError(
        'cli_missing_input',
        'A metric preset or assertion is required.',
        {
          path: '--preset',
          hint: 'Pass --preset, --assert-json, --pattern, a threshold flag, or --path for exists.',
        },
      );
    }
  }

  const parsed = parseWithSchema(metricResourceSchema, {
    schema: METRIC_RESOURCE_SCHEMA_ID,
    id: fields.metricId,
    name: fields.name?.trim() || fields.metricId,
    definition,
  });

  if (!parsed.ok) {
    return yield* new LocalError('cli_usage', 'Metric values do not match the resource schema.', {
      details: { diagnostics: schemaIssueDiagnostics(parsed.error.issues) },
    });
  }

  yield* assertSafeMetricResource(parsed.value);

  return parsed.value;
});

export { createMetricResource };
