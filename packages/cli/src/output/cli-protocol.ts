import {
  CLI_RESULT_SCHEMA_ID,
  cliFailureResultSchema,
  cliSuccessResultSchema,
  type CliError,
  type CliFailureResult,
  type CliSuccessResult,
  type CliWarning,
} from '@attest/contracts';

type CliResultOptions = {
  projectHashBefore?: string | null;
  projectHashAfter?: string | null;
  warnings?: CliWarning[];
};

/** Builds a validated success document; commands that never read a project report null hashes. */
const createCliSuccessResult = (
  command: string,
  result: unknown,
  options: CliResultOptions = {},
): CliSuccessResult =>
  cliSuccessResultSchema.parse({
    schema: CLI_RESULT_SCHEMA_ID,
    ok: true,
    command,
    project_hash_before: options.projectHashBefore ?? null,
    project_hash_after: options.projectHashAfter ?? null,
    result,
    warnings: options.warnings ?? [],
  });

/** Builds a validated failure document from an already sanitized CLI error. */
const createCliFailureResult = (command: string, error: CliError): CliFailureResult =>
  cliFailureResultSchema.parse({
    schema: CLI_RESULT_SCHEMA_ID,
    ok: false,
    command,
    error,
  });

/** Serializes one result document as a single line with no terminal decoration. */
const serializeCliResult = (result: CliSuccessResult | CliFailureResult): string =>
  JSON.stringify(result);

export { createCliFailureResult, createCliSuccessResult, serializeCliResult };
