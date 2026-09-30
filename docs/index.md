# Attest documentation

Attest is a CLI that defines agents, test cases, datasets, and metrics as JSON files, then runs
evaluations and records each run in a local SQLite store. Start with the task you need:

- [Connect an agent](./cli/agents.md): register and probe native, HTTP, process, stream,
  or WebSocket transports.
- [Import tests](./cli/tests-and-datasets.md): add direct cases or import JSON, JSONL, and
  CSV datasets.
- [Write a metric](./cli/metrics.md): create assertion, judge, or executable metrics.
- [Run an evaluation](./cli/eval-runs.md): run tests and read JSON or JSONL results.
- [Debug a failure](./reference/errors.md): find the error code, exit code, and repair
  command.

For a full walkthrough, follow the [five-minute quickstart](./quickstart.md). Coding agents can
start from [llms.txt](../llms.txt).

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

Every transport carries the [`attest.agent-invocation`](./specs/agent-contract.md) protocol.

## Reference

- [Schemas](./reference/schemas.md): schema ids, generated files, and discovery commands.
- [Errors](./reference/errors.md): error meanings, retryability, and repairs.
- [Exit codes](./reference/exit-codes.md): process exit statuses.
- [File layout](./reference/file-layout.md): authored and runtime paths.
- [Agent protocol](./specs/agent-contract.md)
- [Metric protocol](./specs/metric-contract.md)
- [Run bundle (SDK only)](./specs/run-bundle.md)
- [Trace protocol](./specs/trace-schema.md)

When this documentation and the CLI disagree, trust `attest help`, the generated schemas, and
`attest errors`.

## Project and contributor context

- [Package architecture](./ARCHITECTURE.md)
- [Code taste and conventions](./TASTE.md)
- [Testing policy](./TESTING.md)
- [Package scripts](./SCRIPTS.md)
- [Telemetry policy](./TELEMETRY.md)
