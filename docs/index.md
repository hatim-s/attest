# Attest documentation

Attest is a local-first CLI for defining agents, test cases, datasets, and metrics, then
recording reproducible evaluation runs. Start with the journey you need:

- [Connect an agent](./cli/agents.md) — register and probe native, HTTP, process, stream,
  or WebSocket transports.
- [Import tests](./cli/tests-and-datasets.md) — add direct cases or import reusable JSON,
  JSONL, and CSV datasets.
- [Write a metric](./cli/metrics.md) — create assertions, judge metrics, or executable
  metrics.
- [Run an evaluation](./cli/eval-runs.md) — execute tests and consume JSON or JSONL
  results.
- [Debug a failure](./reference/errors.md) — identify a stable error code, exit code, and
  repair command.

For a complete local journey, follow the [five-minute quickstart](./quickstart.md).

## Choose a reading path

### Human operators

1. Run the [quickstart](./quickstart.md).
2. Learn how authored files relate in the [resource model](./concepts/resource-model.md).
3. Follow an execution through the [evaluation lifecycle](./concepts/eval-lifecycle.md).
4. Use the [CLI guide](./cli/index.md) to choose the next command.

### Coding agents

1. Discover commands with `attest help --output json` or a narrower command such as
   `attest help agent add --output json`.
2. Read the versioned request shape with
   `attest schema print attest.command-request/v2 --output json`.
3. Read machine-repairable failures with `attest errors --output json` and the
   [error catalog](./reference/errors.md).
4. Use `--output json` for one `attest.cli-result/v1` document or `--output jsonl` for
   an `attest.cli-event/v1` stream when a command supports streaming.
5. Send mutations with `--if-project-hash <sha256>` when another actor may edit the
   project concurrently.

The compact [llms.txt](../llms.txt) file is the context-limited map of canonical pages,
schemas, and protocol specifications.

## Core concepts

- [Resource model](./concepts/resource-model.md): the manifest, resource identities,
  references, canonical files, and generated schemas.
- [Evaluation lifecycle](./concepts/eval-lifecycle.md): selection, immutable snapshots,
  agent invocation, metric evaluation, persistence, and output modes.

## CLI guides

The [CLI index](./cli/index.md) maps every workflow to its canonical guide:

- [Agents](./cli/agents.md)
- [Tests and datasets](./cli/tests-and-datasets.md)
- [Metrics](./cli/metrics.md)
- [Evaluation runs](./cli/eval-runs.md)

## Integration guides

- [Native agents](./integrations/native.md)
- [cURL and HTTP](./integrations/curl-and-http.md)
- [Managed CLI processes](./integrations/cli-processes.md)
- [Polling and streams](./integrations/polling-and-streams.md)
- [WebSockets](./integrations/websockets.md)

All transports normalize to the same
[`attest.agent/v1alpha1`](./specs/agent-contract.md) runner boundary.

## Reference

- [Schemas](./reference/schemas.md) — schema ids, generated files, and discovery commands.
- [Errors](./reference/errors.md) — stable error meanings, retryability, and repairs.
- [Exit codes](./reference/exit-codes.md) — process-level automation contract.
- [File layout](./reference/file-layout.md) — canonical authored and runtime paths.
- [Agent protocol](./specs/agent-contract.md)
- [Metric protocol](./specs/metric-contract.md)
- [Run bundle](./specs/run-bundle.md)

The [CLI North Star](./design/cli-north-star.md) is the design rationale. The command
tree, generated schemas, and error registry remain the executable sources of truth.
