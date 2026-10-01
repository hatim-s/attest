# Error reference

Branch on the error `code`. The `message` describes one occurrence and can change between
versions. Read the installed registry when automating repairs:

```sh
attest errors --output json
```

The command succeeds with one `attest.cli-result`; `result.schema` is
`attest.cli-errors`, and `result.errors` contains `code`, `meaning`, `likely_causes`,
`retryable`, `exit_code`, and one or more `repairs`.

## Catalog

| Code                           | Exit | Retryable | Meaning and likely cause                                                              | Repair                                                                                   |
| ------------------------------ | ---: | :-------: | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `cancelled`                    |  130 |    yes    | The command was cancelled because the caller sent SIGINT or SIGTERM.                  | Retry when cancellation is no longer required.                                           |
| `cli_missing_input`            |    2 |    no     | A non-interactive command omitted a required flag or request field.                   | Run `attest help <command> --output json` and supply every required value.               |
| `cli_usage`                    |    2 |    no     | The command grammar, argument, option, option value, or strict request is invalid.    | Run `attest help --output json` and use a registered path and valid option combination.  |
| `init_conflict`                |    1 |    no     | Project initialization would replace an existing generated path.                      | Choose an empty directory or explicitly allow replacement where the command supports it. |
| `init_failed`                  |    4 |    yes    | Initialization could not write because the target is unavailable or unwritable.       | Check directory permissions and free space, then retry.                                  |
| `internal_error`               |    4 |    no     | An unexpected implementation or dependency failure escaped classification.            | Retry with the latest Attest version and report the stable error details.                |
| `invocation_failed`            |    4 |    yes    | An agent process or transport did not produce a valid response.                       | Run `attest agent test <agent-id>` and repair the reported transport failure.            |
| `metric_fixture_mismatch`      |    1 |    no     | Metric behavior and the fixture's `expected_pass` disagree.                           | Inspect metric evidence and correct either the metric or fixture expectation.            |
| `metric_infrastructure_failed` |    4 |    yes    | A judge provider, executable metric, or HTTP metric was unavailable.                  | Run `attest metric test <metric-id> --fixture <path>` and repair the boundary.           |
| `output_exists`                |    1 |    no     | An artifact command refuses to replace an existing output.                            | Choose another path or pass the command's explicit replacement flag.                     |
| `output_write_failed`          |    4 |    yes    | The destination is unavailable, full, unsafe, or unwritable.                          | Check the path, permissions, and free space.                                             |
| `project_changed`              |    3 |    yes    | Another process published a project transaction after the caller read it.             | Reload the project hash, rebuild and preview the request, then retry.                    |
| `project_invalid`              |    1 |    no     | Authored schemas, paths, hashes, imports, ids, or cross-references are invalid.       | Fix every source-addressed diagnostic before rerunning.                                  |
| `project_lock_stale`           |    3 |    no     | A dead local process left the mutation lock behind.                                   | Stop automated mutation and leave the lock for a human.                                  |
| `project_locked`               |    3 |    yes    | Another live process owns the mutation lock, or lock safety cannot be established.    | Wait for the owner; never remove a live or unclassified lock.                            |
| `project_not_found`            |    1 |    no     | No project manifest was found within discovery boundaries.                            | Run inside a project or pass the correct `--project <path>`.                             |
| `project_read_failed`          |    1 |    no     | A project file is missing, unreadable, or changed during loading.                     | Restore the reported path and verify permissions.                                        |
| `project_recovery_required`    |    3 |    no     | An interrupted transaction diverged and cannot be recovered automatically.            | Preserve its journal and reconcile every reported path before retrying.                  |
| `project_transaction_failed`   |    4 |    yes    | The filesystem failed while publishing a project transaction.                         | Verify rollback, permissions, and free space before retrying.                            |
| `resource_not_found`           |    1 |    no     | A requested project resource, schema, or local run does not exist.                    | List the relevant collection and retry with an available id.                             |
| `run_failed`                   |    4 |    yes    | Eval orchestration, cancellation registry, event validation, or the run store failed. | Repair the reported run boundary and retry.                                              |
| `trace_convert_failed`         |    1 |    no     | OTLP input is malformed, ambiguous, or lacks the selected trace.                      | Validate the input and pass `--trace-id` for a multi-trace export.                       |

## Failure details

The failure envelope is described in [Schemas](./schemas.md#attestcli-result). Import failures
put every invalid row in `details.diagnostics`, with its physical line or row and mapping address.
Reference blockers can include the exact detach commands to run. Read every diagnostic, and never
echo source values the error left out.

In human mode, the error goes to stderr with its code, message, retryability, path, hint, and
details. Commander rejects bad argv with plain usage text, not JSON. Check a command with
`attest help <command> --output json` before calling it.

## Agent transport failures

When an agent call fails, `attest agent test --output json` returns `invocation_failed` (exit 4).
`details.invocation_code` names the cause:

| `invocation_code`     | Cause                                                                  |
| --------------------- | ---------------------------------------------------------------------- |
| `spawn_failed`        | The process could not start.                                           |
| `nonzero_exit`        | The process exited with a non-zero code.                               |
| `timeout`             | An idle or attempt deadline passed.                                    |
| `output_cap_exceeded` | stdout, a response body, or an event exceeded its byte or count limit. |
| `network`             | The request failed before a response arrived.                          |
| `http_status`         | The endpoint returned a status the transport treats as failure.        |
| `invalid_envelope`    | The output was not a valid envelope, event, or JSONL line.             |

Ctrl-C or SIGTERM returns the top-level `cancelled` error with exit 130. List the installed
grammar and catalog with `attest help agent add --output json` and `attest errors --output json`.

## Repair steps for agents

1. Read `attest help <command> --output json`. Treat `usage`, `arguments`, `options`, `conflicts`,
   `implies`, `choices`, `request_schema`, and `examples` as data.
2. Use one input route per call: flags and arguments, or `--from-json`.
3. Preview a mutation with `--dry-run`, then pass its project hash to `--if-project-hash` on the
   write.
4. Parse stdout for the selected output mode. For JSONL, read the final `result` event.
5. Branch on `error.code` and the process exit. Do not match `message` text.
6. If `details.diagnostics` exists, fix every entry before retrying.
7. `retryable` means a retry can succeed once the condition is fixed or has passed. It is not an
   instruction to retry now.
8. For `project_changed`, reload the project and rebuild the request. Never replay a stale request.
9. For `project_locked`, wait. For `project_lock_stale` or `project_recovery_required`, stop
   automated mutation and leave the lock and journal for a human.
10. After an infrastructure exit, check whether a side effect completed before retrying a
    non-idempotent operation.

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
