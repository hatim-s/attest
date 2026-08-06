# Attest v0 alpha handoff

Status: ready for local developer testing on `main`.

The alpha is a complete local evaluation loop: initialize a project, run CLI or HTTP agents,
evaluate assertions/custom metrics/judges, persist evidence in SQLite, compare runs, inspect traces
in the dashboard, export a self-contained report, and convert OTLP JSON traces.

## Tester setup

Prerequisites: Node.js 22+, Bun 1.3.9+, macOS or Linux.

```bash
git clone https://github.com/hatim-s/attest.git
cd attest
bun install
bun run build

node packages/cli/dist/cli.js init /tmp/attest-alpha-test
cd /tmp/attest-alpha-test
node /path/to/attest/packages/cli/dist/cli.js run
```

Copy the run ID printed by `run`, then exercise the remaining surfaces:

```bash
# Run again and compare the two IDs.
node /path/to/attest/packages/cli/dist/cli.js run --baseline <first-run-id>
node /path/to/attest/packages/cli/dist/cli.js diff <first-run-id> <second-run-id>

# Inspect runs, cases, traces, score distributions, and A/B transitions.
node /path/to/attest/packages/cli/dist/cli.js view

# Produce a single-file, zero-network report.
node /path/to/attest/packages/cli/dist/cli.js report <run-id> --output report.html

# Convert an OTLP/HTTP JSON export to attest.trace/v1alpha1.
node /path/to/attest/packages/cli/dist/cli.js trace convert export.json --output trace.json
```

The generated quickstart includes CLI, HTTP, and traced example agents. Its
`ATTEST_QUICKSTART.md` explains how to switch agent transports. The default store is
`.attest/runs.db`.

## Alpha acceptance checklist

- `attest init` completes without replacing existing files unless `--force` is supplied.
- A default quickstart run passes and persists two case records.
- `--format json` emits one machine-readable document; `--junit` emits CI-readable XML.
- A second run can be compared in both the terminal and dashboard.
- Selecting a traced case opens metric evidence and a virtualized span waterfall.
- Distributions show average metric-score buckets and mutually exclusive case verdicts.
- Compare shows the 3x3 verdict matrix and expandable per-case metric deltas.
- `attest report` opens without a server and performs no network requests.
- `attest trace convert` recognizes the documented Vercel AI SDK and LangSmith OTLP shapes.
- Malformed config, agent output, traces, and overwrite attempts return actionable error codes.

## Verification at handoff

- `bun run build`, `bun run typecheck`, `bun run lint`, and `bun run format:check` pass.
- Canonical `bun run test`: 436 tests pass; six opt-in fuzz tests are skipped unless `FUZZ=1`.
- Browser-controlled acceptance passed for a traced case, distribution charts, two-run verdict
  matrix, and expanded metric delta evidence in dark mode.
- Compiled static-report smoke produced a self-contained two-case HTML file with no external
  script or stylesheet references.
- Compiled OTLP smoke produced the expected agent to LLM/tool trace hierarchy.

Use `bun run test`, not bare `bun test`: the latter invokes Bun's built-in discovery and scans
compiled `dist` tests in addition to the repository's source suites.

## Deliberate alpha cuts and external follow-ups

- The YAML round-trip UI editor (`2W`) is below the alpha cut line; edit YAML/JSON configs in an
  editor for now.
- Multi-turn simulation orchestration (`3S`) is deferred to v0.2. The request contract already
  reserves conversation fields, but the simulator loop is not part of this build.
- Friendly-developer cold testing, final branding, docs-site polish, telemetry delivery, packaged
  binaries, npm publishing, and launch work remain human/release follow-ups.

Roadmap status: <https://hatim-s.github.io/planloft-plans/p/d6omNNpVrp/>
