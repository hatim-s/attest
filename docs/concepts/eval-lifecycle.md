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

## Lifecycle hooks and worker directories

Projects can divide a run into stable local working directories and run argv-only commands around
the run and each case. These directories coordinate files between an agent and hooks. They are not
security sandboxes.

```json
{
  "defaults": {
    "eval": {
      "workers": {
        "count": 4,
        "directory": ".attest/workers/{run_id}/worker-{worker_index}"
      },
      "hooks": {
        "before_run": { "argv": ["node", "./scripts/hooks.mjs", "before-run"] },
        "before_case": { "argv": ["node", "./scripts/hooks.mjs", "before-case"] },
        "after_case": {
          "argv": ["node", "./scripts/hooks.mjs", "after-case"],
          "timeout_ms": 30000
        },
        "after_run": { "argv": ["node", "./scripts/hooks.mjs", "after-run"] }
      }
    }
  }
}
```

Attest splits the configured case order into four balanced contiguous batches. The four workers run
concurrently, while each worker runs its cases one at a time. `after_case` finishes before that
worker receives its next case, so the hook can move files such as `X` and `Y` to a
result directory and then clear the worker directory.
An explicit worker count is the run concurrency and takes precedence over project and test
concurrency defaults. A conflicting `--concurrency` value is rejected.

Save this as `scripts/hooks.mjs`. It creates all four folders before execution, then collects `X` and
`Y` after each case and clears that worker folder:

```js
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

if (process.argv[2] === 'before-run') {
  for (let worker = 0; worker < 4; worker += 1) {
    await mkdir(
      join(
        process.env.ATTEST_PROJECT_ROOT,
        '.attest/workers',
        process.env.ATTEST_RUN_ID,
        `worker-${worker}`,
      ),
      { recursive: true },
    );
  }
}

if (process.argv[2] === 'after-case') {
  const worker = process.env.ATTEST_WORKER_DIRECTORY;
  if (!worker) throw new Error('This cleanup hook requires defaults.eval.workers.');
  const output = join(
    process.env.ATTEST_PROJECT_ROOT,
    'eval-artifacts',
    process.env.ATTEST_RUN_ID,
    process.env.ATTEST_TEST_ID,
    process.env.ATTEST_CASE_ID,
  );
  await mkdir(output, { recursive: true });
  for (const name of ['X', 'Y']) {
    await rename(join(worker, name), join(output, name));
  }
  await rm(worker, { recursive: true, force: true });
  await mkdir(worker, { recursive: true });
}
```

Hook commands do not use a shell. Relative executable paths resolve from the project root. Case
hooks run in their worker directory when workers are configured, or the project root otherwise.
Every hook receives `ATTEST_PROJECT_ROOT` and
`ATTEST_RUN_ID`. Case hooks also receive `ATTEST_WORKER_INDEX`, `ATTEST_TEST_ID`, and
`ATTEST_CASE_ID`. `ATTEST_WORKER_DIRECTORY` is present only when explicit workers are configured;
file cleanup hooks should require it before changing files. Completion hooks receive `ATTEST_CASE_OUTCOME` or
`ATTEST_RUN_STATUS` and `ATTEST_RUN_SUMMARY`. A hook spawn, timeout, exit, or cleanup failure fails
the run. Attest still invokes `after_case` after a case failure and invokes `after_run` after durable
finalization is attempted.
Runs without `defaults.eval.workers` retain the existing per-attempt temporary-directory behavior.
Worker directories currently require `native_cli` agents. Lifecycle hooks without workers remain
available to other transports.
