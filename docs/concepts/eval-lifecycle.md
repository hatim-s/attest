# Evaluation lifecycle

`attest eval run` turns mutable authored resources into an immutable local execution
record. Selection, resolution, invocation, scoring, persistence, and rendering have
separate contracts so both humans and coding agents can diagnose a failure precisely.

## 1. Select tests and cases

Run named tests or explicitly select all tests:

```bash
attest eval run smoke --output json
attest eval run --all --output json
```

In non-interactive mode, omitting both test ids and `--all` returns
`cli_missing_input`. `--case <case-id>` selects exact cases, while repeated
`--tag <tag>` values require all named tags. `--concurrency`, `--timeout`, and
`--baseline` override execution, deadline, and diff settings for this run.

## 2. Resolve an immutable snapshot

Attest discovers and validates `attest.project`, then resolves each selected
`attest.test` through its agent, dataset, and metric references. It expands direct
cases and attached dataset rows, applies defaults and case overrides, and captures the
effective command plus resource content hashes.

Resolution finishes before execution. Missing references, invalid resources, duplicate
case ids, or integrity mismatches fail without creating a partial run. The
[resource model](./resource-model.md) describes the authored graph.

## 3. Invoke the agent

Every transport normalizes one case to an `attest.agent-invocation` request and response at
the runner boundary. Native processes exchange one JSON document over stdin/stdout;
HTTP, polling, streaming, managed-process, and WebSocket adapters map their wire formats
to the same envelope.

The persisted attempt includes the normalized request, bounded and redacted transport
evidence, timing, and extraction decision. See the
[agent protocol](../specs/agent-contract.md) and the integration guides for
[native](../integrations/native.md), [HTTP](../integrations/curl-and-http.md),
[managed processes](../integrations/cli-processes.md),
[polling and streams](../integrations/polling-and-streams.md), and
[WebSockets](../integrations/websockets.md).

## 4. Evaluate metrics

Assertions score normalized output or trace data directly. Judge metrics call their
configured model. Executable metrics exchange the `attest.metric-evaluation` request and
result envelope; HTTP metrics map an equivalent request and result. Thresholds,
per-case overrides, and the test pass gate determine case and run outcomes.

Metric failure and metric infrastructure failure are distinct. A completed evaluation
that fails its quality gate exits `1`; an invocation or metric infrastructure failure
exits `4`. See the [metric protocol](../specs/metric-contract.md) and
[metric guide](../cli/metrics.md).

## 5. Persist the run

Attest writes the immutable eval run to `.attest/runs.db`, including selected case ids,
resource hashes, attempts, metric results, Git metadata when available, timestamps, and
the effective command. Authoring and `attest agent test` do not create this database;
`attest eval run` does.

Subsequent read surfaces consume the persisted record:

```bash
attest show run <run-id> --output json
attest diff <base-run-id> <candidate-run-id> --output json
attest report <run-id>
attest view
```

The [run-bundle specification](../specs/run-bundle.md) defines the portable evidence
format. The [evaluation-run guide](../cli/eval-runs.md) covers selection, cancellation,
diffing, and reports.

## 6. Consume output

With `--output json`, stdout contains exactly one `attest.cli-result` document after
completion. Success includes `ok: true`, `command: "eval.run"`, project hashes, a
command-specific result, and warnings. Failure includes `ok: false`, `command`, and a
structured error with stable `code`, `message`, and `retryable` fields.

Use `--output jsonl` for live machine events:

```bash
attest eval run smoke --output jsonl
```

Each line is one `attest.cli-event` document containing `sequence`, `time`, `event`,
and `data`. Orchestration event ordering is deterministic. Case-completion events retain
actual completion order and carry their configured case index. The final line has
`event: "result"` and wraps the terminal CLI result.

Human `--watch` output is a live renderer and cannot be combined with structured output.
Automation should validate the schemas listed in the
[schema reference](../reference/schemas.md), not scrape prose.

## Cancellation and exit status

Cancel a known run with `attest eval cancel <run-id>`. A signal-cancelled process exits
`130`. The stable process-level matrix is: `0` success, `1` evaluated failure or
user-data validation failure, `2` CLI usage error, `3` stale project conflict, `4`
invocation or metric infrastructure error, and `130` signal cancellation.

The structured error code is more precise than the process exit status. Query
`attest errors --output json`, then use the [error catalog](../reference/errors.md) and
[exit-code reference](../reference/exit-codes.md) to decide whether and how to retry.
