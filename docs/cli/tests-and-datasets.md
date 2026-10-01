# Tests and datasets

## Copy-paste example

Create a test and import one direct JSONL case:

```sh
printf '%s\n' '{"id":"refund-basic","input":"refund policy","expected":"refund policy"}' > cases.jsonl
attest test add smoke --agent support --metric exact --output json
attest test case import smoke ./cases.jsonl --output json
attest test case list smoke --output json
```

## Prerequisites

- Run inside an Attest project.
- The example expects existing agent `support` and metric `exact` resources.
- Use UTF-8 CSV, JSON, or JSONL input. Stdin imports must include `--format` when the format cannot
  be inferred from a filename.

## Expected files

`test add` writes the test file and a direct-case import updates it. A dataset import also writes the
dataset's data and metadata files and updates the manifest. See
[File layout](../reference/file-layout.md) for the paths. Authoring does not create
`.attest/runs.db`.

## Expected stdout

Each command prints one [`attest.cli-result`](../reference/schemas.md#attestcli-result). An
import's `result` holds read, inserted, updated, and skipped row counts, plus each dedupe decision.
A `test case import` that reads more than 100 rows adds the `direct_case_count_high` warning. The
check counts that one import's rows, not the test's total, and the command still succeeds.

## Cleanup

```sh
attest test remove smoke --yes --output json
rm -f cases.jsonl
```

## Resource model

A test names exactly one agent, zero or more metrics, direct cases, and dataset attachments. A
dataset is a reusable project resource; attaching it does not copy rows into the test. Attachment
tags filter a dataset to rows containing every configured tag.

```sh
attest test add smoke --agent support --metric exact --output json
attest test case add smoke --id ping --input '"ping"' --expected '"pong"' --tag fast
attest test dataset add smoke regression --name "Regression set"
attest test dataset attach smoke shared --tag billing
```

Case ids may be explicit. When omitted, Attest derives a stable id from logical case content; the
fingerprint excludes dataset identity, so moving a case between a direct test and a dataset or
renaming a dataset does not change the generated id.

## Interactive import

The import wizard follows the [prompt rules](./index.md#prompts-and-non-interactive-runs). It reads
the source once, detects its format, and validates every row. For CSV without `--map`, it proposes
mappings only from exact header names:

| Case field | CSV headers it matches, in priority order |
| ---------- | ----------------------------------------- |
| `id`       | `id`, `external_id`                       |
| `input`    | `input`, `prompt`, `question`             |
| `expected` | `expected`, `ideal`, `answer`             |
| `params`   | `params`, `parameters`                    |
| `tags`     | `tags`                                    |

Accepting the proposal does not write. Attest prints a semantic dry run, then asks
`Apply this import? [y/N]`. The write is bound to that preview's project hash. `--yes` skips the
confirmation but does not infer missing mappings.

## Non-interactive and JSON flows

Without prompts, supply every required value:

```sh
attest test case import smoke ./cases.csv \
  --format csv \
  --map id=external_id \
  --map input.question=prompt \
  --map expected=answer \
  --key external_id \
  --sync upsert \
  --on-conflict update \
  --output json
```

For an agent-authored request, use one strict `attest.command-request` document:

```json
{
  "schema": "attest.command-request",
  "command": "test.dataset.import",
  "test_id": "smoke",
  "source": "./cases.jsonl",
  "as": "regression",
  "import": {
    "format": "jsonl",
    "mapping": [{ "destination": "input", "source": "/prompt" }],
    "sync": "append",
    "on_conflict": "error"
  }
}
```

```sh
attest test dataset import --from-json ./dataset-import.json --output json
```

`--from-json -` reads the request from stdin, so stdin cannot also be the tabular source. Put
`dry_run`, `yes`, and `if_project_hash` in the request itself.

## CSV, JSON, and JSONL mapping

| Format | Default records               | Mapping source syntax | Notes                                                                                                                                    |
| ------ | ----------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| CSV    | Header row plus data rows     | Exact header name     | At least one explicit or accepted guided mapping is required. RFC 4180 quoting, escaped quotes, CRLF, and quoted newlines are supported. |
| JSON   | Top-level array               | RFC 6901 JSON Pointer | `--records-pointer` may select a nested array.                                                                                           |
| JSONL  | One object per non-empty line | RFC 6901 JSON Pointer | Diagnostics retain physical line numbers.                                                                                                |

Destinations are canonical case fields or nested fields such as `input.question`. Use repeated
`--map destination=source`. Use repeated `--parse-json <source>` when a source string should be
decoded as JSON before assignment. Unsafe prototype-mutating destinations and overlapping parent
and child destinations are rejected.

Without mappings, JSON and JSONL objects are treated as canonical case candidates. Every row is
validated before any write. Malformed JSONL, invalid rows, missing mappings, and collisions are
aggregated in stable source order; diagnostics contain locations and repair hints but not source
values.

## Identity, dedupe, and synchronization

`--key <source>` derives identity from a source field. `--dedupe id|key|content` explicitly keeps
the first within-import duplicate for that basis and reports the decision. Without `--dedupe`, a
duplicate is an error.

`--sync append` is the default. Its default `--on-conflict error` prevents silent replacement;
`skip` retains the existing case and `update` replaces the matching case. `--sync upsert` requires
an explicit mapped id or `--key`; it updates matches in stable order and never deletes existing
rows absent from the source.

Updating an existing dataset requires `--sync upsert`. When other tests share the dataset, Attest
previews every affected test, and `yes: true` skips only the final confirmation. If a generated or
explicit id collides with a direct case or an attached dataset case, the whole import fails and
nothing is written.

## Repair an import

| Failure identity    | Typical diagnostic                                                 | Repair                                                                                           |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `cli_missing_input` | No safe CSV mapping or a required id/source is absent              | Add explicit `--map`, `--as`, test id, and source values.                                        |
| `cli_usage`         | Invalid format, mapping syntax, JSON pointer, UTF-8, or size limit | Read every `error.details.diagnostics` entry, repair the source/options, then rerun `--dry-run`. |
| `project_invalid`   | Duplicate/colliding cases, invalid case shape, or broken reference | Resolve all reported locations; no partial rows were written.                                    |
| `project_changed`   | Project hash changed after preview                                 | Reload the project, rebuild the request, preview again, and retry with the new hash.             |
| `project_locked`    | Another mutation owns the writer lock                              | Wait for the owner; never remove a live lock.                                                    |

For CSV, verify exact header spelling. For JSON/JSONL, verify pointers begin with `/` and escape `~`
as `~0` and `/` as `~1`. A failed import is zero-write; do not attempt to repair generated files by
hand before reading the full aggregate diagnostic list.

## Dataset and case lifecycle

```sh
attest test case show smoke refund-basic --output json
attest test case rename smoke refund-basic refund-renamed --dry-run
attest test case remove smoke refund-renamed --yes --output json

attest test dataset import smoke ./cases.jsonl --as regression --output json
attest test dataset detach smoke regression --output json
attest test dataset rename regression regression-renamed --dry-run
attest test dataset remove regression-renamed --yes --output json
```

`test dataset remove` fails while any test is attached and returns the detach commands to run.

## Agent-readable contract

Treat an import as all-or-nothing and read every entry in `error.details.diagnostics` before
retrying. The general steps are in [Errors](../reference/errors.md#repair-steps-for-agents).
