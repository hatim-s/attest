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
- Set every environment variable that the selected agents and metrics reference.
- The project-local `.attest` path and requested JUnit parent must be safe, writable paths.

## Expected files

The first evaluation creates `.attest/runs.db` and may use SQLite `-wal` and `-shm` sidecars. The
run stores its immutable snapshot, effective command, case attempts, metric results, and summary.
`--junit artifacts/smoke.xml` atomically writes that JUnit file. Active runs temporarily register
under `.attest/eval-runs/`; owned registry files are removed after termination.

## Expected stdout

`--output json` prints one [`attest.cli-result`](../reference/schemas.md#attestcli-result) when
the run ends. Its `result` holds the run and snapshot ids, status, summary, optional baseline and
JUnit fields, and a `verdict` of `pass` or `fail`. A failing verdict is still `ok: true` but exits 1.

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

### Sample and organize cases

```sh
attest eval run support --sample 25
attest eval run support --tag smoke --sample 25 --seed review-42
attest eval run support --folder billing/refunds --dataset historical --sample 25
attest test case add support --input '{"message":"Refund please"}' --folder billing/refunds
```

`--folder` matches a logical case folder and descendants. Folders use slash-separated segments,
without leading/trailing slashes, empty segments, dot segments, or backslashes. They are case
metadata, independent of filesystem paths. JSON/JSONL imports preserve `folder`; CSV mappings
can use `--map folder=category`. Moving a case to another folder preserves its generated id.

`--dataset` selects cases from an attached dataset. Both flags are repeatable. Values within
case-id, folder, and dataset filters match any supplied value; repeated tags require every value.
Different filters intersect, then sampling runs once across the combined population of selected
tests. Dataset attachment tag filters still apply before this population is formed.

`--sample N` selects up to N cases without replacement. If fewer match, all matching cases run.
Zero matches fail before execution. `--seed` requires `--sample`; an omitted seed is generated
and recorded. The versioned `hash-rank-v1` algorithm ranks SHA-256 hashes of the JSON tuple
`[algorithm, seed, test_id, case_id]`, takes the lowest N, and restores configured case order.
The same seed and candidate identities reproduce membership regardless of input enumeration.
Changing the population can change membership; the persisted selected identities are the record
of exactly what ran.

JSON requests use `folders`, `dataset_ids`, and `sample: {"count":25,"seed":"review-42"}`
alongside existing `case_ids` and `tags`. Snapshots, run-start events, and successful results
include `selection` with total, matched, and selected counts plus resolved sampling metadata.
The total counts cases in the selected tests after dataset attachment filters. Excluded cases
are not skipped executions. A passing subset run describes only its selected cases.

When either run selects a subset of cases or the runs select different tests, baseline comparisons
use shared recorded test/case identities for
verdicts and pass rates. Coverage reports shared, baseline-only, and candidate-only counts;
unmatched cases do not become added/removed regressions. CI gates reject comparisons with no
shared cases. Historical snapshots without selection metadata remain readable.

## Interactive, non-interactive, and JSON output

Human output prints a stable final line: `Result: PASS|FAIL|ERROR|CANCELLED (exit N)`. Add
`--watch` to print run/case lifecycle progress; `--watch` conflicts with JSON and JSONL output.

`--output json` prints once, after the run ends. `--output jsonl` prints events as cases finish and
always ends with a `result` event, even when the run fails.

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

The request must set exactly one of a non-empty `test_ids` or `all: true`. `watch` is valid only with
human output.

## Exit and result semantics

Exit 1 covers both a completed run with verdict `fail` and invalid project data. Check `ok` and
`result.verdict`, not the exit code alone. [Exit codes](../reference/exit-codes.md) lists every
code and the JSONL consistency rules.

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

In JSONL, check that `sequence` values are contiguous, that exactly one `result` event ends the
stream, and that its `data.exit_code` matches the process exit. Store `run_id` and `snapshot_hash`
as opaque strings. For the general steps, see
[Repair steps for agents](../reference/errors.md#repair-steps-for-agents).
