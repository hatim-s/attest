# Error reference

Stable error codes are the programmatic failure identity. Messages explain the current occurrence
but are not an API. Read the installed registry when automating repairs:

```sh
attest errors --output json
```

The command succeeds with one `attest.cli-result`; `result.schema` is
`attest.cli-errors`, and `result.errors` contains `code`, `meaning`, `likely_causes`,
`retryable`, `exit_code`, and one or more `repairs`.

## Catalog

| Code                           | Exit | Retryable | Meaning and likely cause                                                              | Repair                                                                                                                          |
| ------------------------------ | ---: | :-------: | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `cancelled`                    |  130 |    yes    | The command was cancelled because the caller sent SIGINT or SIGTERM.                  | Retry when cancellation is no longer required.                                                                                  |
| `cli_missing_input`            |    2 |    no     | A non-interactive command omitted a required flag or request field.                   | Run `attest help <command> --output json` and supply every required value.                                                      |
| `cli_usage`                    |    2 |    no     | The command grammar, argument, option, option value, or strict request is invalid.    | Run `attest help --output json` and use a registered path and valid option combination.                                         |
| `init_conflict`                |    1 |    no     | Project initialization would replace an existing generated path.                      | Choose an empty directory or explicitly allow replacement where the command supports it.                                        |
| `init_failed`                  |    4 |    yes    | Initialization could not write because the target is unavailable or unwritable.       | Check directory permissions and free space, then retry.                                                                         |
| `internal_error`               |    4 |    no     | An unexpected implementation or dependency failure escaped classification.            | Retry with the latest Attest version and report the stable error details.                                                       |
| `invocation_failed`            |    4 |    yes    | An agent process or transport did not produce a valid response.                       | Run `attest agent test <agent-id>` and repair the reported transport failure.                                                   |
| `metric_fixture_mismatch`      |    1 |    no     | Metric behavior and the fixture's `expected_pass` disagree.                           | Inspect metric evidence and correct either the metric or fixture expectation.                                                   |
| `metric_infrastructure_failed` |    4 |    yes    | A judge provider, executable metric, or HTTP metric was unavailable.                  | Run `attest metric test <metric-id> --fixture <path>` and repair the boundary.                                                  |
| `output_exists`                |    1 |    no     | An artifact command refuses to replace an existing output.                            | Choose another path or pass the command's explicit replacement flag.                                                            |
| `output_write_failed`          |    4 |    yes    | The destination is unavailable, full, unsafe, or unwritable.                          | Check the path, permissions, and free space.                                                                                    |
| `project_changed`              |    3 |    yes    | Another process published a project transaction after the caller read it.             | Reload the project hash, rebuild and preview the request, then retry.                                                           |
| `project_invalid`              |    1 |    no     | Authored schemas, paths, hashes, imports, ids, or cross-references are invalid.       | Fix every source-addressed diagnostic before rerunning.                                                                         |
| `project_lock_stale`           |    3 |    no     | A dead local process left the mutation lock behind.                                   | Stop for human repair. The registry mentions `attest project unlock --stale`, but that command is not registered in this build. |
| `project_locked`               |    3 |    yes    | Another live process owns the mutation lock, or lock safety cannot be established.    | Wait for the owner; never remove a live or unclassified lock.                                                                   |
| `project_not_found`            |    1 |    no     | No project manifest was found within discovery boundaries.                            | Run inside a project or pass the correct `--project <path>`.                                                                    |
| `project_read_failed`          |    1 |    no     | A project file is missing, unreadable, or changed during loading.                     | Restore the reported path and verify permissions.                                                                               |
| `project_recovery_required`    |    3 |    no     | An interrupted transaction diverged and cannot be recovered automatically.            | Preserve its journal and reconcile every reported path before retrying.                                                         |
| `project_transaction_failed`   |    4 |    yes    | The filesystem failed while publishing a project transaction.                         | Verify rollback, permissions, and free space before retrying.                                                                   |
| `resource_not_found`           |    1 |    no     | A requested project resource, schema, or local run does not exist.                    | List the relevant collection and retry with an available id.                                                                    |
| `run_failed`                   |    4 |    yes    | Eval orchestration, cancellation registry, event validation, or the run store failed. | Repair the reported run boundary and retry.                                                                                     |
| `trace_convert_failed`         |    1 |    no     | OTLP input is malformed, ambiguous, or lacks the selected trace.                      | Validate the input and pass `--trace-id` for a multi-trace export.                                                              |

## Failure envelope

JSON-mode failures are printed to stdout as one document:

```json
{
  "schema": "attest.cli-result",
  "ok": false,
  "command": "agent.add",
  "error": {
    "code": "cli_missing_input",
    "message": "Required agent input is missing.",
    "path": "--argv-json",
    "hint": "Pass one supported transport selector.",
    "retryable": false
  }
}
```

`path`, `hint`, and `details` are optional. Import `details.diagnostics` may contain every invalid
row with physical line/row and mapping addresses. Reference blockers may include exact detach
commands. Never stop after the first aggregate diagnostic, and never echo source values that the
error intentionally omitted.

In human mode, the error is rendered to stderr with code, message, retryability, path/hint/details,
while a command may also print a stable final result line. Commander grammar errors that occur
before Attest owns rendering can use the registered CLI help/error path; machine callers should
still use `attest help ... --output json` to prevent them.

## Repair algorithm for agents

1. Parse stdout according to the selected output mode. For JSONL, inspect the final `result` event.
2. Read `error.code` and the process exit; do not match `message` text.
3. If `details.diagnostics` exists, repair every entry before retrying.
4. Obey `retryable` only after fixing or waiting for the identified condition. It is not a retry
   command by itself.
5. For `project_changed`, reload and rebuild; never replay a stale writer request blindly.
6. For `project_locked`, wait. For `project_lock_stale` or `project_recovery_required`, stop
   automated mutation and preserve the lock/journal for a human; this build has no registered
   `project unlock` command.
7. For infrastructure exits, verify whether a side effect completed before retrying a
   non-idempotent external operation.

## Common repairs

```sh
# Discover an exact command contract.
attest help test dataset import --output json

# Validate all authored resources and cross-references.
attest project validate --output json

# Retrieve the current optimistic-concurrency hash.
attest project show --output json

# Probe an agent transport separately from an eval.
attest agent test support --input '"ping"' --output json

# Test a metric independently.
attest metric test exact --fixture ./fixture.json --output json

# Inspect the current installed error registry.
attest errors --output json
```

See [Exit codes](./exit-codes.md) for process-level classification,
[Schemas](./schemas.md) for the response contracts, and [File layout](./file-layout.md) before any
manual recovery.
