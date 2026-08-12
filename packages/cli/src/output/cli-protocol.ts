import {
  CLI_EVENT_SCHEMA_ID,
  CLI_RESULT_SCHEMA_ID,
  cliEventSchema,
  cliResultSchema,
  type CliError,
  type CliEvent,
  type CliFailureResult,
  type CliSuccessResult,
  type CliWarning,
  type JsonValue,
} from '@attest/contracts';

type CliResultOptions = {
  projectHashBefore?: string | null;
  projectHashAfter?: string | null;
  warnings?: CliWarning[];
};

type CliEventClock = () => Date;

/** Builds a validated success document with explicit hashes for non-project commands. */
const createCliSuccessResult = (
  command: string,
  result: JsonValue,
  options: CliResultOptions = {},
): CliSuccessResult =>
  cliResultSchema.parse({
    schema: CLI_RESULT_SCHEMA_ID,
    ok: true,
    command,
    project_hash_before: options.projectHashBefore ?? null,
    project_hash_after: options.projectHashAfter ?? null,
    result,
    warnings: options.warnings ?? [],
  }) as CliSuccessResult;

/** Builds a validated failure document from an already sanitized CLI error. */
const createCliFailureResult = (command: string, error: CliError): CliFailureResult =>
  cliResultSchema.parse({
    schema: CLI_RESULT_SCHEMA_ID,
    ok: false,
    command,
    error,
  }) as CliFailureResult;

/** Serializes one non-streaming CLI result without terminal decoration or extra documents. */
const serializeCliResult = (result: CliSuccessResult | CliFailureResult): string =>
  JSON.stringify(cliResultSchema.parse(result));

/** Allocates stable sequence numbers and timestamps for one JSONL command stream. */
class CliEventSerializer {
  private sequence = 0;

  constructor(private readonly clock: CliEventClock = () => new Date()) {}

  /** Serializes the next event as exactly one JSON document without a trailing newline. */
  serialize(event: string, data: JsonValue): string {
    const document: CliEvent = cliEventSchema.parse({
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: this.sequence,
      time: this.clock().toISOString(),
      event,
      data,
    });
    this.sequence += 1;
    return JSON.stringify(document);
  }
}

export {
  CliEventSerializer,
  createCliFailureResult,
  createCliSuccessResult,
  serializeCliResult,
  type CliEventClock,
  type CliResultOptions,
};
