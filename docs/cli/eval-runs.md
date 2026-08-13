# Evaluation runs

## Copy-paste example

Run one test, persist the immutable run, and write JUnit:

```sh
attest eval run smoke --timeout 60s --junit artifacts/smoke.xml --output json
```

For an event stream suitable for an agent or CI log:

```sh
attest eval run smoke --timeout 60s --output jsonl
```

## Prerequisites

- Run inside a valid Attest project with at least one test, agent, metric, and resolved case.
- Ensure every environment variable referenced by the selected agent and metrics is present.
- The project-local `.attest` path and requested JUnit parent must be safe, writable paths.

## Expected files

The first evaluation creates `.attest/runs.db` and may use SQLite `-wal` and `-shm` sidecars. The
run stores its immutable snapshot, effective command, case attempts, metric results, and summary.
`--junit artifacts/smoke.xml` atomically writes that JUnit file. Active runs temporarily register
under `.attest/eval-runs/`; owned registry files are removed after termination.

## Expected stdout

`--output json` emits one `attest.cli-result` document after completion. A completed run has
`command: "eval.run"`, run and snapshot ids, status, summary, optional baseline/JUnit fields, and a
`verdict` of `pass` or `fail`. A failing verdict is still `ok: true` but exits 1.

`--output jsonl` emits one `attest.cli-event` document per line with contiguous zero-based
`sequence` values. It begins with `run_started`, emits ordered case starts and observed-order case
completions, then exactly one `run_completed` and exactly one final `result`. A failure before
orchestration is a single `result` event.

## Cleanup

```sh
rm -f artifacts/smoke.xml .attest/runs.db .attest/runs.db-shm .attest/runs.db-wal
rmdir artifacts .attest/eval-runs .attest 2>/dev/null || true
```

## Select work

Pass one or more test ids, or `--all`; they are mutually exclusive. With no selection, a human TTY
prompts `Test ids (space-separated) or all [all]`. Non-interactive callers receive
`cli_missing_input` instead.

```sh
attest eval run refund safety --output human
attest eval run --all --concurrency 4 --timeout 2m --output json
```

Repeat `--case <case-id>` to select exact case ids. Repeat `--tag <tag>` to require every selected
tag. The resolver freezes selected tests and cases, resource hashes, project hash, configured
order, effective concurrency/timeout/output, and optional Git metadata before execution.

## Interactive, non-interactive, and JSON output

Human output prints a stable final line: `Result: PASS|FAIL|ERROR|CANCELLED (exit N)`. Add
`--watch` to print run/case lifecycle progress; `--watch` conflicts with JSON and JSONL output.

Structured output disables prompts. `--output json` waits for the terminal envelope. JSONL streams
events as work proceeds and always terminates with a result event, including after a producer
failure. Do not mix human status parsing with machine modes.

For a strict command request:

```json
{
  "schema": "attest.command-request",
  "command": "eval.run",
  "test_ids": ["smoke"],
  "case_ids": ["refund-basic"],
  "concurrency": 2,
  "timeout_ms": 60000,
  "output": "jsonl"
}
```

```sh
attest eval run --from-json ./eval-run.json
```

`--from-json` conflicts with test arguments and every run-selection/output flag. The document must
choose exactly one of non-empty `test_ids` or `all: true`; `watch` is valid only with human output.
Use `attest schema print attest.command-request --output json` for the complete strict union.

## Exit and result semantics

| Exit | Eval meaning                                                                          |
| ---: | ------------------------------------------------------------------------------------- |
|    0 | Completed with verdict `pass`; final result has `ok: true`.                           |
|    1 | Completed with verdict `fail` and `ok: true`, or failed user/project data validation. |
|    2 | Invalid command grammar or missing non-interactive input.                             |
|    3 | Project concurrency, lock, stale-lock, or recovery conflict.                          |
|    4 | Invocation, metric, run-store, artifact, or unexpected infrastructure failure.        |
|  130 | Cancelled by SIGINT/SIGTERM or a run cancellation request.                            |

Always inspect both the process exit and final result. Exit 1 is deliberately not synonymous with a
malformed JSON response: a normal evaluated test failure has `ok: true` and `verdict: "fail"`.

## Cancel a run

From another process in the same project, address the immutable run id printed by `run_started` or
the JSON result:

```sh
attest eval cancel 01ARZ3NDEKTSV4RRFFQ69G5FAV --output json
```

The successful result status is `cancellation_requested`, `already_cancelled`, or
`already_terminal`. Cross-process cancellation writes an authenticated, run-scoped request under
`.attest/eval-runs`; it does not send a process-wide signal. The active runner converts the request
to adapter cancellation, records terminal case/run state, and cleans its registry ownership.

The strict request is:

```json
{
  "schema": "attest.command-request",
  "command": "eval.cancel",
  "run_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "output": "json"
}
```

```sh
attest eval cancel --from-json ./eval-cancel.json
```

Cancellation requires a run id and supports human or JSON output, not JSONL.

## Baselines and artifacts

Compare during execution by passing an existing run id:

```sh
attest eval run smoke --baseline 01ARZ3NDEKTSV4RRFFQ69G5FAA --output json
```

The candidate is fully recorded before the stored baseline diff is calculated. For later
inspection:

```sh
attest diff 01ARZ3NDEKTSV4RRFFQ69G5FAA 01ARZ3NDEKTSV4RRFFQ69G5FAV --format json
attest report 01ARZ3NDEKTSV4RRFFQ69G5FAV --output artifacts/run.html
attest view --no-open --port 0
```

`diff`, `report`, and `view` default to `.attest/runs.db`; pass `--store <path>` to select another
store. `report` refuses to replace an existing artifact unless `--force` is explicit. JUnit is
written through a verified, atomically renamed temporary file; unsafe paths and write failures use
stable artifact error identities.

## Agent-readable contract

1. Read `attest help eval run --output json` and honor every conflict, implication, repeatability
   marker, constraint, and the `attest.command-request` request schema.
2. Select JSON for one terminal envelope or JSONL for progress; never scrape human output.
3. In JSONL, verify `schema`, exact sequence continuity, one final `result`, and
   `result.data.exit_code` consistency with its nested `attest.cli-result`.
4. Persist `run_id` and `snapshot_hash` as opaque values. Do not derive either from display text.
5. On error, branch on stable `error.code` and `retryable`; use the catalog in
   [Errors](../reference/errors.md).

See [Schemas](../reference/schemas.md), [Exit codes](../reference/exit-codes.md), and
[File layout](../reference/file-layout.md).
