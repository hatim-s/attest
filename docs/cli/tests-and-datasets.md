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

`test add` writes `attest/tests/smoke.json`. A direct-case import updates that same file. A dataset
import additionally writes `attest/datasets/<dataset-id>.jsonl`,
`attest/datasets/<dataset-id>.meta.json`, and updates `attest.project.json`. Authoring does not
create `.attest/runs.db`.

## Expected stdout

With `--output json`, each command emits one `attest.cli-result` document. Import success
includes deterministic counts such as read, inserted, updated, and skipped rows plus addressable
dedupe decisions when applicable. Warnings are structured; importing more than 100 direct cases
adds `direct_case_count_high` without changing success into failure.

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

The import wizard is active only on a human TTY without `--non-interactive`, structured output, or
`--from-json`. It reads the source once, detects its format, and validates the complete source.
For CSV without explicit mappings, it proposes only conservative matches for canonical header
names such as `input`, `prompt`, `question`, `expected`, `params`, `tags`, and `id`. Accepting a
proposal is not the write: Attest first prints a bounded semantic dry run, then asks
`Apply this import? [y/N]`. The final write is bound to that preview's project hash.

`--yes` bypasses confirmations but does not infer missing mappings. `--dry-run` performs no writes,
locks, recovery, or timestamp changes.

## Non-interactive and JSON flows

Structured output implies non-interactive behavior. Supply every required value explicitly:

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

`--from-json -` consumes the request from stdin, so it cannot also be the tabular source. Flags and
arguments conflict with `--from-json`; place dry-run, confirmation, and optimistic-hash fields in
the request itself.

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

Updating an existing dataset requires `--sync upsert`. If the dataset is shared across tests,
Attest always shows a semantic preview of every affected test; `yes: true` only bypasses the final
confirmation. Generated or explicit ids that collide with direct cases or applicable attached
dataset cases fail atomically.

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

Dataset removal is blocked while any test remains attached and returns copy-paste detach commands.
Test, case, and dataset mutations accept `--dry-run`, `--yes`, `--from-json`, and
`--if-project-hash`; read commands accept `--project` and human/JSON output.

## Agent-readable contract

1. Query `attest help test case import --output json` or
   `attest help test dataset import --output json` at runtime.
2. Use its `usage`, exact option choices/defaults, conflicts, constraints, examples, and
   `request_schema`; do not infer a field name.
3. Preview before a write and bind the write to `project_hash_before` with `--if-project-hash`.
4. Treat an import as all-or-nothing. On failure, iterate through every structured diagnostic.
5. Parse stdout as one `attest.cli-result` document and branch on stable error codes documented
   in [Errors](../reference/errors.md).

See also [Schemas](../reference/schemas.md), [Exit codes](../reference/exit-codes.md), and
[File layout](../reference/file-layout.md).
