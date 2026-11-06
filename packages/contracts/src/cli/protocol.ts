import { nonnegativeIntegerSchema, timestampSchema } from '../schema/scalars.js';
import * as Schema from 'effect/Schema';

import { metricPresetSchema } from '../metric/presets.js';
import { jsonValueSchema, sha256Schema } from '../project/shared.js';
import {
  CLI_ERROR_CATALOG_SCHEMA_ID,
  CLI_EVENT_SCHEMA_ID,
  CLI_HELP_SCHEMA_ID,
  CLI_RESULT_SCHEMA_ID,
} from '../schema/identifiers.js';

const cliCommandSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/, {
    message: 'must be a dotted lowercase command path',
  }),
);

const cliPathSchema = Schema.String.check(Schema.isMinLength(1));

const cliFailureExitCodes = [1, 2, 3, 4, 130] as const;

const cliFailureExitCodeSchema = Schema.Literals(cliFailureExitCodes);

const cliExitCodeSchema = Schema.Literals([0, ...cliFailureExitCodes]);

/** Carries a stable non-fatal diagnostic alongside a successful result. */
const cliWarningSchema = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1)),
  message: Schema.String.check(Schema.isMinLength(1)),
  path: Schema.optional(cliPathSchema),
  details: Schema.optional(jsonValueSchema),
});

/** Carries the stable failure identity and repair data exposed to CLI callers. */
const cliErrorSchema = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1)),
  message: Schema.String.check(Schema.isMinLength(1)),
  path: Schema.optional(cliPathSchema),
  hint: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  retryable: Schema.Boolean,
  details: Schema.optional(jsonValueSchema),
});

const cliSuccessResultSchema = Schema.Struct({
  schema: Schema.Literal(CLI_RESULT_SCHEMA_ID),
  ok: Schema.Literal(true),
  command: cliCommandSchema,
  project_hash_before: Schema.NullOr(sha256Schema),
  project_hash_after: Schema.NullOr(sha256Schema),
  result: jsonValueSchema,
  warnings: Schema.Array(cliWarningSchema),
});

const cliFailureResultSchema = Schema.Struct({
  schema: Schema.Literal(CLI_RESULT_SCHEMA_ID),
  ok: Schema.Literal(false),
  command: cliCommandSchema,
  error: cliErrorSchema,
});

/** Defines the one-document response emitted by every non-streaming machine command. */
const cliResultSchema = Schema.Union([cliSuccessResultSchema, cliFailureResultSchema]);

/** Defines one deterministic line in a CLI JSONL stream. */
const cliEventSchema = Schema.Struct({
  schema: Schema.Literal(CLI_EVENT_SCHEMA_ID),
  sequence: nonnegativeIntegerSchema,
  time: timestampSchema,
  event: Schema.String.check(
    Schema.isPattern(/^[a-z][a-z0-9_]*$/, { message: 'must be a lowercase event name' }),
  ),
  data: jsonValueSchema,
});

const cliHelpArgumentSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  usage: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.String,
  required: Schema.Boolean,
  variadic: Schema.Boolean,
  choices: Schema.Array(jsonValueSchema),
  default: Schema.NullOr(jsonValueSchema),
});

const cliHelpOptionSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  flags: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.String,
  value_name: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  required: Schema.Boolean,
  repeatable: Schema.Boolean,
  choices: Schema.Array(jsonValueSchema),
  default: Schema.NullOr(jsonValueSchema),
  conflicts: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  implies: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
});

/** Recursively describes one command and every currently registered child command. */
const cliHelpCommandFields = {
  path: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  name: Schema.String.check(Schema.isMinLength(1)),
  summary: Schema.String,
  usage: Schema.String.check(Schema.isMinLength(1)),
  arguments: Schema.Array(cliHelpArgumentSchema),
  options: Schema.Array(cliHelpOptionSchema),
  aliases: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  alias_for: Schema.NullOr(cliCommandSchema),
  request_schema: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  examples: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  constraints: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  presets: Schema.optional(Schema.Array(metricPresetSchema)),
};

type CliHelpCommandNode = Schema.Struct.Type<typeof cliHelpCommandFields> & {
  readonly subcommands: readonly CliHelpCommandNode[];
};

const cliHelpCommandSchema: Schema.Codec<CliHelpCommandNode> = Schema.Struct({
  ...cliHelpCommandFields,
  subcommands: Schema.Array(Schema.suspend(() => cliHelpCommandSchema)),
});

/** Defines the command tree carried by a successful help result. */
const cliHelpSchema = Schema.Struct({
  schema: Schema.Literal(CLI_HELP_SCHEMA_ID),
  command: cliHelpCommandSchema,
});

/** Defines one stable catalog entry including the repair and process-status contract. */
const cliErrorDefinitionSchema = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1)),
  meaning: Schema.String.check(Schema.isMinLength(1)),
  likely_causes: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  retryable: Schema.Boolean,
  exit_code: cliFailureExitCodeSchema,
  repairs: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
});

/** Defines the error registry returned by `attest errors`. */
const cliErrorCatalogSchema = Schema.Struct({
  schema: Schema.Literal(CLI_ERROR_CATALOG_SCHEMA_ID),
  errors: Schema.Array(cliErrorDefinitionSchema),
});

type CliError = typeof cliErrorSchema.Type;

type CliErrorCatalog = typeof cliErrorCatalogSchema.Type;

type CliErrorDefinition = typeof cliErrorDefinitionSchema.Type;

type CliEvent = typeof cliEventSchema.Type;

type CliExitCode = typeof cliExitCodeSchema.Type;

type CliFailureResult = typeof cliFailureResultSchema.Type;

type CliHelp = typeof cliHelpSchema.Type;

type CliHelpArgument = typeof cliHelpArgumentSchema.Type;

type CliHelpCommand = typeof cliHelpCommandSchema.Type;

type CliHelpOption = typeof cliHelpOptionSchema.Type;

type CliResult = typeof cliResultSchema.Type;

type CliSuccessResult = typeof cliSuccessResultSchema.Type;

type CliWarning = typeof cliWarningSchema.Type;

export {
  cliCommandSchema,
  cliErrorCatalogSchema,
  cliErrorDefinitionSchema,
  cliErrorSchema,
  cliEventSchema,
  cliExitCodeSchema,
  cliFailureResultSchema,
  cliHelpArgumentSchema,
  cliHelpCommandSchema,
  cliHelpOptionSchema,
  cliHelpSchema,
  cliResultSchema,
  cliSuccessResultSchema,
  cliWarningSchema,
  type CliError,
  type CliErrorCatalog,
  type CliErrorDefinition,
  type CliEvent,
  type CliExitCode,
  type CliFailureResult,
  type CliHelp,
  type CliHelpArgument,
  type CliHelpCommand,
  type CliHelpOption,
  type CliResult,
  type CliSuccessResult,
  type CliWarning,
};
