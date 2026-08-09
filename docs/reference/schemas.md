# Schema reference

Attest publishes JSON Schemas generated from the same runtime definitions used by the CLI. Treat
the generated files and `attest schema` output as authoritative; prose summarizes their roles but
does not replace validation.

## Discover and print

```sh
attest schema list --output json
attest schema print attest.command-request/v2 --output json
attest schema print agent.v2.json --output json
```

`schema list` returns one `attest.cli-result/v1` whose `result.items` entries contain the printable
`id` and generated `file`. `schema print` accepts that id or filename and returns
`result: { file, id, schema }`. In human mode, `schema print` writes the raw JSON Schema.

Only `attest.command-request/v2`, `attest.metric-preset/v1`, and
`attest.metric-test-fixture/v1` currently have symbolic print aliases. Other documents are printed
by generated filename even when their in-document `schema` discriminator is an `attest.*` value.

## Canonical authored resources

| Document discriminator | Generated schema                                                    | Authored location                    |
| ---------------------- | ------------------------------------------------------------------- | ------------------------------------ |
| `attest.project/v2`    | [project.v2.json](../../packages/schemas/generated/project.v2.json) | `attest.project.json`                |
| `attest.agent/v2`      | [agent.v2.json](../../packages/schemas/generated/agent.v2.json)     | `attest/agents/<id>.json`            |
| `attest.test/v2`       | [test.v2.json](../../packages/schemas/generated/test.v2.json)       | `attest/tests/<id>.json`             |
| `attest.case/v2`       | [case.v2.json](../../packages/schemas/generated/case.v2.json)       | Direct case or one dataset JSONL row |
| `attest.dataset/v2`    | [dataset.v2.json](../../packages/schemas/generated/dataset.v2.json) | `attest/datasets/<id>.meta.json`     |
| `attest.metric/v2`     | [metric.v2.json](../../packages/schemas/generated/metric.v2.json)   | `attest/metrics/<id>.json`           |

The manifest contains canonical paths and SHA-256 content hashes. Dataset entries bind both JSONL
data bytes and metadata bytes. Runtime loading validates strict shapes, canonical paths, hash
integrity, unique ids/case ids, manifest parity, and every agent/metric/dataset reference before a
command acts.

## Command and CLI protocols

| Document discriminator          | Generated schema                                                                            | Contract                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `attest.command-request/v2`     | [command-request.v2.json](../../packages/schemas/generated/command-request.v2.json)         | Strict `--from-json` union for project, agent, test/dataset, metric, and eval commands. |
| `attest.cli-result/v1`          | [cli-result.v1.json](../../packages/schemas/generated/cli-result.v1.json)                   | Exactly one success/failure document for non-streaming machine output.                  |
| `attest.cli-event/v1`           | [cli-event.v1.json](../../packages/schemas/generated/cli-event.v1.json)                     | One sequenced JSONL event line.                                                         |
| `attest.cli-help/v1`            | [cli-help.v1.json](../../packages/schemas/generated/cli-help.v1.json)                       | Versioned command tree returned inside a CLI result.                                    |
| `attest.cli-errors/v1`          | [cli-errors.v1.json](../../packages/schemas/generated/cli-errors.v1.json)                   | Stable error catalog returned inside a CLI result.                                      |
| `attest.metric-preset/v1`       | [metric-preset.v1.json](../../packages/schemas/generated/metric-preset.v1.json)             | One authoring preset included by metric JSON help.                                      |
| `attest.metric-test-fixture/v1` | [metric-test-fixture.v1.json](../../packages/schemas/generated/metric-test-fixture.v1.json) | Strict local fixture for `metric test`.                                                 |

### `attest.cli-result/v1`

A success document contains:

```json
{
  "schema": "attest.cli-result/v1",
  "ok": true,
  "command": "agent.add",
  "project_hash_before": null,
  "project_hash_after": "<sha256>",
  "result": {},
  "warnings": []
}
```

A failure contains only `schema`, `ok: false`, `command`, and `error`. The error has stable `code`,
human `message`, `retryable`, and optional `path`, `hint`, and structured `details`. See
[Errors](./errors.md).

### `attest.cli-event/v1`

Every line has `schema`, non-negative `sequence`, ISO timestamp `time`, lowercase `event`, and
event-specific `data`. Eval streams narrow the vocabulary to `run_started`, `case_started`,
`case_completed`, `run_completed`, and final `result`. The nested final CLI result and exit code
must be compatible; see [Evaluation runs](../cli/eval-runs.md).

### `attest.command-request/v2`

The union is strict: unknown fields, the wrong dotted `command`, incomplete nested resources, and
mixed request variants fail. Mutation branches may carry `dry_run`, `yes`, and
`if_project_hash`. A request passed through `--from-json` must be the sole authoring input source.

Discover flag-to-request behavior through versioned help:

```sh
attest help agent add --output json
attest help test dataset import --output json
attest help metric add --output json
attest help eval run --output json
```

The help command object exposes arguments, options, defaults, choices, conflicts, implied flags,
repeatability, request schema id, examples, aliases, deprecation data, constraints, and metric
presets where applicable.

## Agent and metric execution protocols

| Document discriminator   | Generated schema                                                                              | Producer to consumer                             |
| ------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `attest.agent/v1alpha1`  | [agent-request.v1alpha1.json](../../packages/schemas/generated/agent-request.v1alpha1.json)   | Attest to a native or normalized agent adapter.  |
| `attest.agent/v1alpha1`  | [agent-response.v1alpha1.json](../../packages/schemas/generated/agent-response.v1alpha1.json) | Agent adapter back to Attest.                    |
| `attest.metric/v1alpha1` | [metric-request.v1alpha1.json](../../packages/schemas/generated/metric-request.v1alpha1.json) | Attest to an executable or normalized metric.    |
| `attest.metric/v1alpha1` | [metric-result.v1alpha1.json](../../packages/schemas/generated/metric-result.v1alpha1.json)   | Metric back to Attest with score/pass evidence.  |
| `attest.trace/v1alpha1`  | [trace.v1alpha1.json](../../packages/schemas/generated/trace.v1alpha1.json)                   | Normalized trace evidence used by trace metrics. |

The shared discriminator names a protocol family; request and response/result schemas remain
separate generated files. Native processes exchange one JSON document on stdin/stdout. JSONL and
WebSocket adapters add transport-specific correlation envelopes while preserving the normalized
agent request/response semantics.

## Streaming and WebSocket transport schemas

| Generated schema                                                                            | Purpose                                                                   |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [jsonl-bridge-input.v1.json](../../packages/schemas/generated/jsonl-bridge-input.v1.json)   | Correlated invocation/cancellation input lines for managed JSONL bridges. |
| [jsonl-bridge-output.v1.json](../../packages/schemas/generated/jsonl-bridge-output.v1.json) | Correlated result/error output lines.                                     |
| [websocket-request.v1.json](../../packages/schemas/generated/websocket-request.v1.json)     | WebSocket invocation request mapping.                                     |
| [websocket-message.v1.json](../../packages/schemas/generated/websocket-message.v1.json)     | Accepted text-JSON WebSocket message vocabulary.                          |
| [websocket-evidence.v1.json](../../packages/schemas/generated/websocket-evidence.v1.json)   | Bounded WebSocket protocol evidence.                                      |

## Eval schemas

| Generated schema                                                                            | Purpose                                                                                |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [eval-run-request.v2.json](../../packages/schemas/generated/eval-run-request.v2.json)       | Strict test/all selection, filters, concurrency, timeout, baseline, JUnit, and output. |
| [eval-cancel-request.v2.json](../../packages/schemas/generated/eval-cancel-request.v2.json) | Run-scoped cancellation request.                                                       |
| [eval-cancel-result.v1.json](../../packages/schemas/generated/eval-cancel-result.v1.json)   | Cancellation success/failure result.                                                   |
| [eval-run.v1.json](../../packages/schemas/generated/eval-run.v1.json)                       | Immutable persisted run snapshot and effective command.                                |
| [eval-event.v1.json](../../packages/schemas/generated/eval-event.v1.json)                   | Eval-specific `attest.cli-event/v1` union and final result compatibility.              |

## Validation rules for agents

1. Select a schema using `schema list`; do not synthesize a filename from a discriminator.
2. Validate before invoking the CLI, then still handle a structured CLI failure because project
   hashes and cross-resource invariants require current filesystem state.
3. Keep JSON objects strict. Do not pass undocumented fields for future compatibility.
4. Preserve ids, hashes, JSON pointers, ULIDs, and schema strings exactly as returned.
5. Regenerate or retrieve schemas from the installed CLI version instead of caching prose shapes
   indefinitely.

Related references: [Errors](./errors.md), [Exit codes](./exit-codes.md), and
[File layout](./file-layout.md).
