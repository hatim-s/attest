# Metrics

## Copy-paste example

Author an exact-output assertion and reference it from a new test:

```sh
attest metric add exact --preset output-equals --value '"refund policy"' --output json
attest test add scored-smoke --agent support --metric exact --output json
attest show metric exact --output json
```

## Prerequisites

- Run inside an Attest project.
- The test example expects agent `support` to exist.
- Values passed to `--value`, `--assert-json`, schemas, bodies, and pointer terminal values are JSON,
  not shell strings with implicit conversion.

## Expected files

`metric add` writes `attest/metrics/exact.json` and updates its entry in `attest.project.json`.
`test add` writes `attest/tests/scored-smoke.json` with the metric reference. No run database is
created by authoring or inspection.

## Expected stdout

`--output json` emits one `attest.cli-result` document. A successful mutation reports
`project_hash_before`, `project_hash_after`, the authored resource identity, and semantic
operations. Inspection redacts environment-backed secret references where appropriate.

## Cleanup

```sh
attest test remove scored-smoke --yes --output json
attest metric remove exact --yes --output json
```

## Interactive authoring

With a human TTY, `attest metric add` asks for the metric id, then shows the preset
catalog. The default kind is assertion. Assertion guidance selects `input`, `output`, `expected`,
or `trace` evidence and an operator; trace guidance also displays whether authored agents advertise
trace support. Judge, command, and HTTP kinds select their matching preset. Missing required values
are prompted, then the CLI shows a redacted semantic preview and asks for confirmation.

Prompts are disabled in CI, with non-TTY input/output, with `--non-interactive`, with
`--output json`, or when `--from-json` is used. `--yes` accepts a confirmation but cannot supply a
missing id, rubric, model, executable argv, URL, or assertion value. `--dry-run` is zero-write.

## Non-interactive and JSON flows

Supply a preset and all its required values:

```sh
attest metric add contains \
  --preset output-contains \
  --value '"approved"' \
  --output json

attest metric add rubric \
  --preset judge-rubric \
  --model openai/gpt-5 \
  --rubric 'Pass when the answer is correct and cites its evidence.' \
  --threshold 0.8 \
  --output json
```

All mutations accept a complete `attest.command-request` document through `--from-json`:

```sh
attest metric add --from-json ./metric-add.json --output json
attest metric import --from-json ./metric-import.json --output json
```

The request source conflicts with metric arguments, definition flags, `--dry-run`, `--yes`, and
`--if-project-hash`; encode those fields in the request. Discover the exact union branch with:

```sh
attest help metric add --output json
attest schema print attest.command-request --output json
```

## Presets

`attest help metric add --output json` returns the preset objects, including their version,
required inputs, configurable fields, and normalized definitions.

| Preset            | Required input                           | Purpose                                                         |
| ----------------- | ---------------------------------------- | --------------------------------------------------------------- |
| `output-equals`   | `--value <json>`                         | Deep equality at `--path` (default `$.output`).                 |
| `output-contains` | `--value <json>`                         | String substring or deep-equal array member.                    |
| `output-schema`   | `--json-schema` or `--json-schema-file`  | Draft 2020-12 validation.                                       |
| `judge-rubric`    | `--model`, `--rubric` or `--rubric-file` | Provider/model judge with optional threshold (default 0.8).     |
| `command`         | `--argv-json`                            | Trusted local executable using `attest.metric-evaluation`.      |
| `http`            | `--url`                                  | Trusted HTTP metric with score/pass extraction pointers.        |
| `tool-called`     | `--tool`                                 | Match tool name, status, count, and optional argument matchers. |
| `tool-order`      | repeated `--order`                       | Require chronological tool names.                               |
| `no-tool-errors`  | none                                     | Require zero failed tool spans.                                 |
| `trace-span`      | none                                     | Match trace span kind/name/status/attributes/count/order.       |

For assertions that do not fit a preset, repeat `--assert-json` with complete assertion-check JSON.
Scalar helpers include `--path`, `--value`, `--pattern`, `--flags`, `--lt`, `--lte`, `--gt`, and
`--gte`. Trace helpers include `--tool-status`, `--count`, argument matchers, span filters, and
attributes.

## Executable and HTTP metrics

Executable metrics are trusted local argv arrays; Attest does not invoke a shell:

```sh
attest metric add local-score \
  --preset command \
  --argv-json '["node","./metrics/score.mjs"]' \
  --cwd . \
  --env API_KEY=METRIC_API_KEY \
  --timeout 30s \
  --dry-run
```

HTTP metrics describe a request and normalized result extraction:

```sh
attest metric add remote-score \
  --preset http \
  --url https://metrics.example.com/score \
  --http-method POST \
  --header-env Authorization=METRIC_TOKEN \
  --score-pointer /score \
  --pass-pointer /pass \
  --rationale-pointer /rationale \
  --dry-run
```

Only environment-variable names are persisted for `--env`, `--header-env`, and `--query-env`.
Metric authoring does not call a judge or HTTP endpoint; execution occurs during `metric test` or an
evaluation as supported by the selected metric runner.

## Import and local fixture tests

Import a canonical `attest.metric` resource from a file or stdin:

```sh
attest metric import ./metric.json --type json --as correct --output json
attest metric import - --type json --as correct --output json
```

Test a metric against a strict local fixture:

```json
{
  "schema": "attest.metric-test-fixture",
  "case": { "id": "refund-basic", "input": "refund policy" },
  "expected_pass": true,
  "output": "refund policy",
  "trace": null
}
```

```sh
attest metric test exact --fixture ./fixture.json --output json
```

The fixture contains a canonical case, expected verdict, arbitrary JSON output, and either an
`attest.trace` document or `null`. A verdict mismatch is
`metric_fixture_mismatch` (exit 1). A judge, executable, or HTTP boundary failure is
`metric_infrastructure_failed` (exit 4). `--from-json -` and `--fixture -` cannot share the same
stdin stream.

## Rename, detach, and remove

Renaming updates every test metric reference atomically. Removal is blocked while references exist
unless `--detach` removes those references explicitly:

```sh
attest metric rename exact exact-renamed --dry-run
attest metric remove exact-renamed --dry-run
attest metric remove exact-renamed --detach --yes --output json
```

The implemented command tree attaches a metric when a test is created with `test add --metric`; it
does not expose a later `test metric attach` or `detach` command. To change an existing test's
metric list, recreate that test through the supported authoring surface. `metric remove --detach`
can explicitly remove references before deleting a metric.

## Agent-readable contract

1. Read `attest help metric add --output json`; its `presets` array is the canonical authoring
   catalog.
2. Select one input route: flags or `--from-json`. Parse JSON-valued flags before constructing the
   command.
3. Use `--dry-run`, then bind the reviewed state with `--if-project-hash` for the write.
4. Parse one `attest.cli-result` from stdout and branch on `ok` and stable `error.code`.
5. Retrieve `attest.metric`, `attest.metric-evaluation`, and fixture schemas through
   `attest schema list --output json` and `attest schema print`.

See [Schemas](../reference/schemas.md), [Errors](../reference/errors.md),
[Exit codes](../reference/exit-codes.md), and [File layout](../reference/file-layout.md).
