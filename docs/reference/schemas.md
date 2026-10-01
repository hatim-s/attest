# Schema reference

The JSON Schemas in `packages/schemas/generated` are generated from the Zod schemas the CLI
validates with. When this page and a schema disagree, the schema is right.

## Discover and print

```sh
attest schema list --output json
attest schema print attest.command-request --output json
attest schema print agent.json --output json
```

`schema list` returns one `attest.cli-result` whose `result.items` entries contain the printable
`id` and generated `file`. `schema print` accepts that id or filename and returns
`result: { file, id, schema }`. In human mode, `schema print` writes the raw JSON Schema.

Only `attest.command-request`, `attest.metric-preset`, and
`attest.metric-test-fixture` currently have symbolic print aliases. Other documents are printed
by generated filename even when their in-document `schema` discriminator is an `attest.*` value.

## Canonical authored resources

| Document discriminator | Generated schema                                              |
| ---------------------- | ------------------------------------------------------------- |
| `attest.project`       | [project.json](../../packages/schemas/generated/project.json) |
| `attest.agent`         | [agent.json](../../packages/schemas/generated/agent.json)     |
| `attest.test`          | [test.json](../../packages/schemas/generated/test.json)       |
| `attest.case`          | [case.json](../../packages/schemas/generated/case.json)       |
| `attest.dataset`       | [dataset.json](../../packages/schemas/generated/dataset.json) |
| `attest.metric`        | [metric.json](../../packages/schemas/generated/metric.json)   |

[File layout](./file-layout.md) gives each file's path. An `attest.case` is a direct case in a test
file or one row of a dataset's JSONL file.

The manifest contains canonical paths and SHA-256 content hashes. Dataset entries bind both JSONL
data bytes and metadata bytes. Runtime loading validates strict shapes, canonical paths, hash
integrity, unique ids/case ids, manifest parity, and every agent/metric/dataset reference before a
command acts.

## Command and CLI protocols

| Document discriminator       | Generated schema                                                                      | Contract                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `attest.command-request`     | [command-request.json](../../packages/schemas/generated/command-request.json)         | Strict `--from-json` union for project, agent, test/dataset, metric, and eval commands. |
| `attest.cli-result`          | [cli-result.json](../../packages/schemas/generated/cli-result.json)                   | Exactly one success/failure document for non-streaming machine output.                  |
| `attest.cli-event`           | [cli-event.json](../../packages/schemas/generated/cli-event.json)                     | One sequenced JSONL event line.                                                         |
| `attest.cli-help`            | [cli-help.json](../../packages/schemas/generated/cli-help.json)                       | Command tree returned inside a CLI result.                                              |
| `attest.cli-errors`          | [cli-errors.json](../../packages/schemas/generated/cli-errors.json)                   | Stable error catalog returned inside a CLI result.                                      |
| `attest.metric-preset`       | [metric-preset.json](../../packages/schemas/generated/metric-preset.json)             | One authoring preset included by metric JSON help.                                      |
| `attest.metric-test-fixture` | [metric-test-fixture.json](../../packages/schemas/generated/metric-test-fixture.json) | Strict local fixture for `metric test`.                                                 |

### `attest.cli-result`

A success document contains:

```json
{
  "schema": "attest.cli-result",
  "ok": true,
  "command": "agent.add",
  "project_hash_before": null,
  "project_hash_after": "<sha256>",
  "result": {},
  "warnings": []
}
```

A failure contains only `schema`, `ok: false`, `command`, and `error`:

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

`code` is stable. `message` is for humans. `path`, `hint`, and `details` are optional. JSON mode
prints failures to stdout like successes. See [Errors](./errors.md) for every code.

### `attest.cli-event`

Every line has `schema`, non-negative `sequence`, ISO timestamp `time`, lowercase `event`, and
event-specific `data`. Eval streams narrow the vocabulary to `run_started`, `case_started`,
`case_completed`, `run_completed`, and final `result`. The nested final CLI result and exit code
must agree; see [Evaluation runs](../cli/eval-runs.md).

### `attest.command-request`

The union is strict: unknown fields, the wrong dotted `command`, incomplete nested resources, and
mixed request variants fail. Mutation branches may carry `dry_run`, `yes`, and
`if_project_hash`. A request passed through `--from-json` must be the sole authoring input source.

Discover flag-to-request behavior through structured help:

```sh
attest help agent add --output json
attest help test dataset import --output json
attest help metric add --output json
attest help eval run --output json
```

The help command object exposes arguments, options, defaults, choices, conflicts, implied flags,
repeatability, request schema id, examples, aliases, constraints, and metric
presets where applicable.

## Agent and metric execution protocols

| Document discriminator     | Generated schema                                                            | Producer to consumer                             |
| -------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| `attest.agent-invocation`  | [agent-request.json](../../packages/schemas/generated/agent-request.json)   | Attest to a native or normalized agent adapter.  |
| `attest.agent-invocation`  | [agent-response.json](../../packages/schemas/generated/agent-response.json) | Agent adapter back to Attest.                    |
| `attest.metric-evaluation` | [metric-request.json](../../packages/schemas/generated/metric-request.json) | Attest to an executable or normalized metric.    |
| `attest.metric-evaluation` | [metric-result.json](../../packages/schemas/generated/metric-result.json)   | Metric back to Attest with score/pass evidence.  |
| `attest.trace`             | [trace.json](../../packages/schemas/generated/trace.json)                   | Normalized trace evidence used by trace metrics. |

The shared discriminator names a protocol family; request and response/result schemas remain
separate generated files. Native processes exchange one JSON document on stdin/stdout. JSONL and
WebSocket adapters add transport-specific correlation envelopes while preserving the normalized
agent request/response semantics.

## Streaming and WebSocket transport schemas

| Generated schema                                                                      | Purpose                                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [jsonl-bridge-input.json](../../packages/schemas/generated/jsonl-bridge-input.json)   | Correlated invocation/cancellation input lines for managed JSONL bridges. |
| [jsonl-bridge-output.json](../../packages/schemas/generated/jsonl-bridge-output.json) | Correlated result/error output lines.                                     |
| [websocket-request.json](../../packages/schemas/generated/websocket-request.json)     | WebSocket invocation request mapping.                                     |
| [websocket-message.json](../../packages/schemas/generated/websocket-message.json)     | Accepted text-JSON WebSocket message vocabulary.                          |
| [websocket-evidence.json](../../packages/schemas/generated/websocket-evidence.json)   | Bounded WebSocket protocol evidence.                                      |

## Eval schemas

| Generated schema                                                                      | Purpose                                                                                |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [eval-run-request.json](../../packages/schemas/generated/eval-run-request.json)       | Strict test/all selection, filters, concurrency, timeout, baseline, JUnit, and output. |
| [eval-cancel-request.json](../../packages/schemas/generated/eval-cancel-request.json) | Run-scoped cancellation request.                                                       |
| [eval-cancel-result.json](../../packages/schemas/generated/eval-cancel-result.json)   | Cancellation success/failure result.                                                   |
| [eval-run.json](../../packages/schemas/generated/eval-run.json)                       | Immutable persisted run snapshot and effective command.                                |
| [eval-event.json](../../packages/schemas/generated/eval-event.json)                   | Eval-specific `attest.cli-event` union and final result consistency.                   |

## Validation rules for agents

Pick a schema with `schema list` instead of building a filename from a discriminator. Validating
before a call does not replace handling the CLI's failure, because project hashes and cross-resource
checks depend on current files. See [Repair steps for agents](./errors.md#repair-steps-for-agents).

Related references: [Errors](./errors.md), [Exit codes](./exit-codes.md), and
[File layout](./file-layout.md).
