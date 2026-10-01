import {
  CLI_ERROR_CATALOG_SCHEMA_ID,
  cliErrorCatalogSchema,
  type CliErrorCatalog,
  type CliErrorDefinition,
} from '@attest/contracts';

const CLI_ERROR_DEFINITIONS = {
  cloud_auth_required: {
    meaning: 'Cloud authentication is required.',
    likely_causes: ['The CLI session expired or was revoked.'],
    retryable: false,
    exit_code: 2,
    repairs: ['Run attest cloud login --url <cloud-origin>.'],
  },
  cloud_credentials_failed: {
    meaning: 'Private cloud credentials could not be saved.',
    likely_causes: ['The credential directory is not writable.'],
    retryable: true,
    exit_code: 4,
    repairs: ['Check permissions for ~/.attest/cloud.'],
  },
  cloud_request_failed: {
    meaning: 'The cloud rejected the request.',
    likely_causes: ['The request conflicts with cloud state or limits.'],
    retryable: false,
    exit_code: 4,
    repairs: ['Inspect the remote_code detail and correct the request.'],
  },
  cloud_unavailable: {
    meaning: 'The cloud request did not complete.',
    likely_causes: ['The endpoint or network is unavailable.'],
    retryable: true,
    exit_code: 4,
    repairs: ['Check the endpoint and reconnect with the last event cursor.'],
  },
  cancelled: {
    meaning: 'The command was cancelled by a process signal.',
    likely_causes: ['The caller sent SIGINT or SIGTERM.'],
    retryable: true,
    exit_code: 130,
    repairs: ['Retry the command when cancellation is no longer required.'],
  },
  cli_missing_input: {
    meaning: 'A non-interactive command is missing required input.',
    likely_causes: ['A required flag or command-request field was omitted.'],
    retryable: false,
    exit_code: 2,
    repairs: ['Run `attest help <command> --output json` and supply every required value.'],
  },
  cli_usage: {
    meaning: 'The command line does not match the registered command grammar.',
    likely_causes: ['A command, argument, option, or option value is invalid.'],
    retryable: false,
    exit_code: 2,
    repairs: ['Run `attest help --output json` and use a registered command path.'],
  },
  init_conflict: {
    meaning: 'Project initialization would replace an existing file.',
    likely_causes: ['The target directory already contains a generated path.'],
    retryable: false,
    exit_code: 1,
    repairs: ['Choose an empty directory or explicitly allow replacement.'],
  },
  init_failed: {
    meaning: 'Project initialization failed while writing local files.',
    likely_causes: ['The target directory is unavailable or not writable.'],
    retryable: true,
    exit_code: 4,
    repairs: ['Check directory permissions and available disk space, then retry.'],
  },
  internal_error: {
    meaning: 'The CLI encountered an unexpected internal failure.',
    likely_causes: ['An unclassified implementation or dependency error occurred.'],
    retryable: false,
    exit_code: 4,
    repairs: ['Retry with the latest Attest version and report the stable error details.'],
  },
  invocation_failed: {
    meaning: 'An agent invocation failed at the infrastructure boundary.',
    likely_causes: ['The agent process or transport did not produce a valid response.'],
    retryable: true,
    exit_code: 4,
    repairs: ['Run `attest agent test <agent-id>` and repair the reported transport failure.'],
  },
  metric_fixture_mismatch: {
    meaning: 'A metric result did not match the local fixture expectation.',
    likely_causes: ['The metric behavior or the fixture expected verdict is incorrect.'],
    retryable: false,
    exit_code: 1,
    repairs: ['Inspect the metric evidence and update either the metric or fixture expectation.'],
  },
  metric_infrastructure_failed: {
    meaning: 'A metric could not execute at the infrastructure boundary.',
    likely_causes: ['A judge provider, executable metric, or HTTP metric was unavailable.'],
    retryable: true,
    exit_code: 4,
    repairs: ['Run `attest metric test <metric-id> --fixture <path>` and repair the failure.'],
  },
  output_exists: {
    meaning: 'The requested output path already exists.',
    likely_causes: ['The command refuses to replace an artifact by default.'],
    retryable: false,
    exit_code: 1,
    repairs: ['Choose another output path or explicitly allow replacement.'],
  },
  output_write_failed: {
    meaning: 'The CLI could not write the requested output artifact.',
    likely_causes: ['The destination is unavailable, full, or not writable.'],
    retryable: true,
    exit_code: 4,
    repairs: ['Check the destination path, permissions, and available disk space.'],
  },
  project_changed: {
    meaning: 'The project changed after the caller read it.',
    likely_causes: ['Another process published a project transaction first.'],
    retryable: true,
    exit_code: 3,
    repairs: ['Read the current project hash, rebuild the request, and retry.'],
  },
  project_invalid: {
    meaning: 'The discovered project contains invalid authored data.',
    likely_causes: ['A resource schema, path, hash, or cross-reference check failed.'],
    retryable: false,
    exit_code: 1,
    repairs: ['Fix every source-addressed project diagnostic and rerun the command.'],
  },
  project_lock_stale: {
    meaning: 'A dead local process left the project mutation lock behind.',
    likely_causes: ['A prior Attest mutation was interrupted before releasing its lock.'],
    retryable: false,
    exit_code: 3,
    repairs: [
      'Confirm no Attest process is running, delete `.attest/project.lock`, then rerun the command to recover the journal.',
    ],
  },
  project_locked: {
    meaning: 'Another live process owns the project mutation lock.',
    likely_causes: ['A concurrent Attest mutation is still running.'],
    retryable: true,
    exit_code: 3,
    repairs: ['Wait for the owner to finish; never remove a live lock.'],
  },
  project_not_found: {
    meaning: 'No project manifest was discovered within the allowed boundaries.',
    likely_causes: ['The command is outside a project or the explicit project path is incorrect.'],
    retryable: false,
    exit_code: 1,
    repairs: ['Run from a project or pass the correct `--project <path>`.'],
  },
  project_read_failed: {
    meaning: 'A discovered project resource could not be read.',
    likely_causes: ['A project file is missing, unreadable, or changed during loading.'],
    retryable: false,
    exit_code: 1,
    repairs: ['Restore the reported project file and verify its permissions.'],
  },
  project_recovery_required: {
    meaning: 'An interrupted project transaction cannot be recovered without human repair.',
    likely_causes: ['A project file changed outside Attest after the transaction was interrupted.'],
    retryable: false,
    exit_code: 3,
    repairs: [
      'Preserve the transaction journal and reconcile every reported path before retrying.',
    ],
  },
  project_transaction_failed: {
    meaning: 'A project transaction failed while publishing local files.',
    likely_causes: ['The filesystem became unavailable, full, or denied a write.'],
    retryable: true,
    exit_code: 4,
    repairs: [
      'Verify the rollback result, filesystem permissions, and free space before retrying.',
    ],
  },
  resource_not_found: {
    meaning: 'The requested project resource or local run does not exist.',
    likely_causes: ['The id is incorrect or the resource was removed.'],
    retryable: false,
    exit_code: 1,
    repairs: ['List the resource collection and retry with an available id.'],
  },
  run_failed: {
    meaning: 'The evaluation command failed before producing a normal result.',
    likely_causes: ['The run store or orchestration infrastructure failed.'],
    retryable: true,
    exit_code: 4,
    repairs: ['Use the reported message to repair the run boundary and retry.'],
  },
  trace_convert_failed: {
    meaning: 'Trace conversion could not produce a valid Attest trace.',
    likely_causes: ['The input is malformed, ambiguous, or contains no selected trace.'],
    retryable: false,
    exit_code: 1,
    repairs: [
      'Validate the OTLP JSON and provide `--trace-id` when the input has multiple traces.',
    ],
  },
} satisfies Record<string, Omit<CliErrorDefinition, 'code'>>;

type CliErrorCode = keyof typeof CLI_ERROR_DEFINITIONS;

/** Looks up the exit code and retryability that every renderer reports for one error code. */
const getCliErrorDefinition = (code: CliErrorCode): CliErrorDefinition => ({
  code,
  ...CLI_ERROR_DEFINITIONS[code],
});

/** Builds the registry printed by `attest errors`, in the alphabetical order it is authored in. */
const createCliErrorCatalog = (): CliErrorCatalog =>
  cliErrorCatalogSchema.parse({
    schema: CLI_ERROR_CATALOG_SCHEMA_ID,
    errors: Object.entries(CLI_ERROR_DEFINITIONS).map(([code, definition]) => ({
      code,
      ...definition,
    })),
  });

/** Renders the registry as one block per code with its exit status and first repair. */
const renderCliErrorCatalog = (catalog: CliErrorCatalog): string =>
  catalog.errors
    .map(
      (definition) =>
        `${definition.code} (exit ${definition.exit_code})\n` +
        `  ${definition.meaning}\n` +
        `  Repair: ${definition.repairs[0] ?? 'Consult structured help.'}`,
    )
    .join('\n\n');

export { createCliErrorCatalog, getCliErrorDefinition, renderCliErrorCatalog, type CliErrorCode };
