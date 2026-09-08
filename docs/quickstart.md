# Five-minute native-agent quickstart

## Copy-paste example

First [build the CLI or install an alpha archive](../README.md#try-it-from-source).
The source setup defines `attest` as a shell function in your current terminal.
Create an isolated directory with the source setup, then run the example:

```bash
ATTEST_EXAMPLE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/attest-quickstart.XXXXXX")"
cd "$ATTEST_EXAMPLE_DIR"
```

If you installed the archives locally, stay in that installation directory and use
`npx attest` in place of `attest` below.

```bash
cat > agent.mjs <<'EOF'
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
// Echo the normalized request input through the native agent response protocol.
process.stdout.write(JSON.stringify({ protocol: 'attest.agent-invocation', output: request.input }));
EOF
printf '%s\n' '{"id":"refund-basic","input":"refund policy","expected":"refund policy"}' > cases.jsonl

attest project init . --name support --non-interactive --output json
attest agent add support --argv-json '["node","./agent.mjs"]' --timeout 5s --output json
attest agent test support --input '"ping"' --output json
attest metric add exact --preset output-equals --value '"refund policy"' --output json
attest test add smoke --agent support --metric exact --output json
attest test case import smoke ./cases.jsonl --output json
attest eval run smoke --output json
```

## Prerequisites

- Node.js 22.15 or newer.
- The built or installed CLI from the [setup instructions](../README.md#try-it-from-source).
- An empty writable directory. Do not run the example inside an existing Attest project.
- No credentials or network access are required for the evaluation.

## Expected files

After initialization and authoring, the directory contains `attest.project.json`,
`attest/agents/support.json`, `attest/metrics/exact.json`, and
`attest/tests/smoke.json`. `agent.mjs` and `cases.jsonl` are the two input fixtures.

No `attest.config.json` is created. `.attest/runs.db` remains absent through authoring and
is created only by `attest eval run smoke --output json`.

## Expected stdout

Each `--output json` command writes exactly one JSON document and no progress prose to
stdout. Every document has `"schema":"attest.cli-result"`, `ok`, and the exact
command id. In order, the ids are `project.init`, `agent.add`, `agent.test`, `metric.add`,
`test.add`, `test.case.import`, and `eval.run`. Successful documents also contain
`project_hash_before`, `project_hash_after`, `result`, and `warnings`.

The full envelope is defined in [schema reference](./reference/schemas.md). If a command
fails, inspect `error.code` and use the [error catalog](./reference/errors.md); do not
parse `error.message` as an API.

The evaluation should exit `0`, with `result.verdict: "pass"` and a
`result.run_id`. A completed evaluation with a failing score exits `1` even though
the envelope has `ok: true`.

## Cleanup

Leave the directory, then remove the example directory you created. Cleanup removes the
authored resources and local run database; Attest does not create remote state in this
journey.

## What the commands created

`attest.project.json` is the `attest.project` manifest. It indexes canonical resource
files and their content hashes. The `support` agent uses the native
`attest.agent-invocation` stdin/stdout protocol. The `exact` metric compares output with
the literal expected value. The `smoke` test binds the agent and metric, and the JSONL
import adds the `refund-basic` case.

The final command resolves those authored resources into an immutable evaluation
snapshot and persists its results. Read the [resource model](./concepts/resource-model.md)
and [evaluation lifecycle](./concepts/eval-lifecycle.md) for those boundaries.

## Next steps

- Run `attest list runs --output json` and inspect a returned id with
  `attest show run <run-id> --output json`.
- Open the local dashboard with `attest view --no-open`, then open its printed URL
  in your browser. Stop the server with Ctrl+C.
- [Connect other agent transports](./cli/agents.md).
- [Import CSV, JSON, or JSONL tests and datasets](./cli/tests-and-datasets.md).
- [Create assertion, judge, and executable metrics](./cli/metrics.md).
- [Select, stream, cancel, diff, and report runs](./cli/eval-runs.md).
- [Discover installed CLI contracts](./cli/index.md#discover-commands-without-prose).
