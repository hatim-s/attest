import { z } from 'zod';

import { sha256Schema } from './v2-shared.js';
import {
  CLI_ERROR_CATALOG_SCHEMA_VERSION,
  CLI_EVENT_SCHEMA_VERSION,
  CLI_HELP_SCHEMA_VERSION,
  CLI_RESULT_SCHEMA_VERSION,
} from './versions.js';

const jsonValueSchema = z.json();
const cliCommandSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/, 'must be a dotted lowercase command path');
const cliPathSchema = z.string().min(1);
const cliExitCodeSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(130),
]);
const cliFailureExitCodeSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(130),
]);

/** Carries a stable non-fatal diagnostic alongside a successful result. */
const cliWarningSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  path: cliPathSchema.optional(),
  details: jsonValueSchema.optional(),
});

/** Carries the stable failure identity and repair data exposed to CLI callers. */
const cliErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  path: cliPathSchema.optional(),
  hint: z.string().min(1).optional(),
  retryable: z.boolean(),
  details: jsonValueSchema.optional(),
});

const cliSuccessResultSchema = z.strictObject({
  schema: z.literal(CLI_RESULT_SCHEMA_VERSION),
  ok: z.literal(true),
  command: cliCommandSchema,
  project_hash_before: sha256Schema.nullable(),
  project_hash_after: sha256Schema.nullable(),
  result: jsonValueSchema,
  warnings: z.array(cliWarningSchema),
});

const cliFailureResultSchema = z.strictObject({
  schema: z.literal(CLI_RESULT_SCHEMA_VERSION),
  ok: z.literal(false),
  command: cliCommandSchema,
  error: cliErrorSchema,
});

/** Defines the one-document response emitted by every non-streaming machine command. */
const cliResultSchema = z.discriminatedUnion('ok', [
  cliSuccessResultSchema,
  cliFailureResultSchema,
]);

/** Defines one deterministic line in a CLI JSONL stream. */
const cliEventSchema = z.strictObject({
  schema: z.literal(CLI_EVENT_SCHEMA_VERSION),
  sequence: z.number().int().nonnegative(),
  time: z.iso.datetime({ offset: true }),
  event: z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be a lowercase event name'),
  data: jsonValueSchema,
});

const cliHelpArgumentSchema = z.strictObject({
  name: z.string().min(1),
  usage: z.string().min(1),
  description: z.string(),
  required: z.boolean(),
  variadic: z.boolean(),
  choices: z.array(jsonValueSchema),
  default: jsonValueSchema.nullable(),
});

const cliHelpOptionSchema = z.strictObject({
  name: z.string().min(1),
  flags: z.string().min(1),
  description: z.string(),
  value_name: z.string().min(1).nullable(),
  required: z.boolean(),
  repeatable: z.boolean(),
  choices: z.array(jsonValueSchema),
  default: jsonValueSchema.nullable(),
  conflicts: z.array(z.string().min(1)),
  implies: z.array(z.string().min(1)),
});

type CliHelpCommand = {
  path: string[];
  name: string;
  summary: string;
  usage: string;
  arguments: z.infer<typeof cliHelpArgumentSchema>[];
  options: z.infer<typeof cliHelpOptionSchema>[];
  subcommands: CliHelpCommand[];
  aliases: string[];
  alias_for: string | null;
  deprecated: string | null;
  request_schema: string | null;
  examples: string[];
};

/** Recursively describes one command and every currently registered child command. */
const cliHelpCommandSchema: z.ZodType<CliHelpCommand> = z.lazy(() =>
  z.strictObject({
    path: z.array(z.string().min(1)),
    name: z.string().min(1),
    summary: z.string(),
    usage: z.string().min(1),
    arguments: z.array(cliHelpArgumentSchema),
    options: z.array(cliHelpOptionSchema),
    subcommands: z.array(cliHelpCommandSchema),
    aliases: z.array(z.string().min(1)),
    alias_for: cliCommandSchema.nullable(),
    deprecated: z.string().min(1).nullable(),
    request_schema: z.string().min(1).nullable(),
    examples: z.array(z.string().min(1)),
  }),
);

/** Defines the versioned command tree carried by a successful help result. */
const cliHelpSchema = z.strictObject({
  schema: z.literal(CLI_HELP_SCHEMA_VERSION),
  command: cliHelpCommandSchema,
});

/** Defines one stable catalog entry including the repair and process-status contract. */
const cliErrorDefinitionSchema = z.strictObject({
  code: z.string().min(1),
  meaning: z.string().min(1),
  likely_causes: z.array(z.string().min(1)),
  retryable: z.boolean(),
  exit_code: cliFailureExitCodeSchema,
  repairs: z.array(z.string().min(1)),
});

/** Defines the versioned error registry returned by `attest errors`. */
const cliErrorCatalogSchema = z.strictObject({
  schema: z.literal(CLI_ERROR_CATALOG_SCHEMA_VERSION),
  errors: z.array(cliErrorDefinitionSchema),
});

type CliError = z.infer<typeof cliErrorSchema>;
type CliErrorCatalog = z.infer<typeof cliErrorCatalogSchema>;
type CliErrorDefinition = z.infer<typeof cliErrorDefinitionSchema>;
type CliEvent = z.infer<typeof cliEventSchema>;
type CliExitCode = z.infer<typeof cliExitCodeSchema>;
type CliFailureResult = z.infer<typeof cliFailureResultSchema>;
type CliHelp = z.infer<typeof cliHelpSchema>;
type CliHelpArgument = z.infer<typeof cliHelpArgumentSchema>;
type CliHelpOption = z.infer<typeof cliHelpOptionSchema>;
type CliResult = z.infer<typeof cliResultSchema>;
type CliSuccessResult = z.infer<typeof cliSuccessResultSchema>;
type CliWarning = z.infer<typeof cliWarningSchema>;

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
