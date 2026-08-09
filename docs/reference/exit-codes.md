# Exit codes

Attest uses a closed process-status set: `0`, `1`, `2`, `3`, `4`, and `130`. The exit code is a
broad operational class; the stable error code or eval verdict is the precise identity.

| Exit | Class                                  | Examples                                                                                                                 | Retry rule                                                                 |
| ---: | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
|    0 | Success                                | Mutation/read completed; eval verdict is `pass`; cancellation request accepted.                                          | No retry needed.                                                           |
|    1 | User/project data or evaluated failure | Invalid project, missing resource, output collision, fixture mismatch, trace conversion failure, or eval verdict `fail`. | Repair data or accept the evaluated failure; do not retry unchanged.       |
|    2 | CLI input/grammar                      | `cli_usage`, `cli_missing_input`.                                                                                        | Read machine help and repair the invocation/request.                       |
|    3 | Local concurrency/recovery             | Project changed, locked, stale-locked, or needs recovery.                                                                | Reload/wait or follow the explicit recovery path; never steal a live lock. |
|    4 | Infrastructure/internal                | Filesystem write, invocation, metric provider, run store, transaction, initialization, or internal failure.              | Verify side effects and repair the boundary before retrying.               |
|  130 | Cancellation                           | SIGINT, SIGTERM, or a requested active-run cancellation.                                                                 | Retry only if cancellation is no longer desired.                           |

## Eval exception at exit 1

A normal evaluated failure is a successful protocol result with a failing verdict:

```json
{
  "schema": "attest.cli-result/v1",
  "ok": true,
  "command": "eval.run",
  "project_hash_before": "<sha256>",
  "project_hash_after": "<same-sha256>",
  "result": {
    "run_id": "<ulid>",
    "snapshot_hash": "<sha256>",
    "status": "completed",
    "summary": {
      "total_cases": 1,
      "passed_cases": 0,
      "failed_cases": 1,
      "error_cases": 0,
      "metric_error_count": 0
    },
    "verdict": "fail"
  },
  "warnings": []
}
```

That document exits 1. Other exit-1 conditions may be `ok: false`, such as `project_invalid`.
Therefore automation must inspect both `ok` and, for successful eval results, `result.verdict`.

## JSON and JSONL

Non-streaming `--output json` prints exactly one `attest.cli-result/v1`. Success omits `error`;
failure omits project hashes, `result`, and `warnings`.

Eval `--output jsonl` ends with one `attest.cli-event/v1` result line whose data is:

```json
{
  "exit_code": 1,
  "result": {
    "schema": "attest.cli-result/v1",
    "ok": true,
    "command": "eval.run",
    "project_hash_before": "<sha256>",
    "project_hash_after": "<same-sha256>",
    "result": { "verdict": "fail" },
    "warnings": []
  }
}
```

The actual nested eval result includes the full run identity and summary. The final event's
`data.exit_code` equals the process exit. Result compatibility is strict:

- exit 0 requires `ok: true` and verdict `pass`;
- exit 1 allows `ok: true` with verdict `fail` or an exit-1 failure envelope;
- exits 2, 3, 4, and 130 require a failure envelope;
- a result-only JSONL stream represents a failure before orchestration and cannot be exit 0 or a
  successful evaluated failure.

## Shell handling

Capture output and exit independently; do not let `set -e` erase the response before inspection:

```sh
result_file=$(mktemp)
if attest eval run smoke --output json >"$result_file"; then
  status=0
else
  status=$?
fi

jq . "$result_file"
printf 'attest exit: %s\n' "$status"
rm -f "$result_file"
```

For JSONL, validate every line and retain the last event:

```sh
attest eval run smoke --output jsonl | tee eval.jsonl
jq -c . eval.jsonl >/dev/null
tail -n 1 eval.jsonl | jq '{event, exit: .data.exit_code, result: .data.result}'
```

When a pipeline matters, preserve the Attest process status using the shell's pipeline-status
facility rather than returning only the last consumer's status.

## Stable identity within each exit

Multiple error codes intentionally share an exit. Query the installed catalog:

```sh
attest errors --output json | jq '.result.errors[] | {code, exit_code, retryable}'
```

Never build a repair from the exit alone. For example, exit 3 can mean “reload a changed project,”
“wait for a live lock,” “explicitly remove a proven stale lock,” or “stop for human recovery.”
Those actions are not interchangeable.

See [Errors](./errors.md) for every stable identity and repair, and [Schemas](./schemas.md) for the
machine envelopes.
