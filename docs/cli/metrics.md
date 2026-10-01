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

`metric add` writes the metric file and updates its manifest entry. `test add` writes the test file
with the metric reference. See [File layout](../reference/file-layout.md) for the paths. Authoring
and inspection do not create a run database.

## Expected stdout

Each command prints one [`attest.cli-result`](../reference/schemas.md#attestcli-result). A
mutation's `result` names the authored resource and lists the semantic operations.

## Cleanup

```sh
attest test remove scored-smoke --yes --output json
attest metric remove exact --yes --output json
```

## Interactive authoring

When [prompts are enabled](./index.md#prompts-and-non-interactive-runs), `attest metric add` asks
for the metric id, then shows the preset catalog. The default kind is assertion. Assertion prompts
choose `input`, `output`, `expected`, or `trace` evidence and an operator. Trace prompts also show
whether authored agents declare trace support. Judge, command, and HTTP kinds use their matching
preset. The CLI prompts for missing values, shows a redacted preview, and asks for confirmation.

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

Both authoring commands accept a complete `attest.command-request` through `--from-json`:

```sh
attest metric add --from-json ./metric-add.json --output json
attest metric import --from-json ./metric-import.json --output json
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
Authoring never calls a judge or HTTP endpoint. `metric test` and `eval run` do.

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

## Rename and remove

See [Rename and remove](./index.md#rename-and-remove). Tests list their metrics when created with
`test add --metric`. No command attaches a metric to an existing test. To change a test's metrics,
recreate the test.

## Agent-readable contract

`attest help metric add --output json` returns the preset catalog in its `presets` array. For the
general steps, see [Repair steps for agents](../reference/errors.md#repair-steps-for-agents).
