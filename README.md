# Attest

Attest runs evaluations against your agents and records the inputs, outputs, metric
results, and traces locally. Define an agent, import cases, choose metrics, and run a
test from the CLI. Compare runs in CI or inspect them in the local dashboard.

This is the first alpha. Start with the credential-free native agent example before
connecting a real service. CLI contracts and TypeScript APIs may change between alpha
versions. macOS and Linux are the current CI targets; Windows is not yet a release
target.

## Try it from source

Use Node.js 22.15 or newer and Bun 1.4. Run these commands from this checkout's root:

```bash
bun install --frozen-lockfile
bun run build
ATTEST_CLI="$PWD/packages/cli/dist/cli.js"
attest() { node "$ATTEST_CLI" "$@"; }
attest --version
attest --help
```

The shell function makes the built CLI available in this terminal, including after
changing directories. Rebuild after editing source. Follow the
[five-minute quickstart](docs/quickstart.md) to create and evaluate a project in a
temporary directory. The evaluation example needs no API keys or network access;
installing dependencies does.

For an alpha archive supplied by a maintainer, install all supplied `.tgz` files in
an empty directory:

```bash
npm install /absolute/path/to/release/*.tgz
npx attest --help
```

Use `npx attest` for each quickstart command when using this installation. Keep the
example in that directory so `npx` can find the local installation. The
[release guide](docs/RELEASING.md) covers producing and checking these archives.
Registry installation becomes available after the maintainer publishes the alpha.

## Use Attest

- [Quickstart](docs/quickstart.md): one agent, one case, one metric, and a saved run.
- [Connect an agent](docs/cli/agents.md): native processes, HTTP, streams, and WebSockets.
- [Import cases and datasets](docs/cli/tests-and-datasets.md).
- [Write metrics](docs/cli/metrics.md): assertions, model judges, and executables.
- [Inspect and compare runs](docs/cli/eval-runs.md): JSON, JSONL, JUnit, reports, and dashboard.
- [Integrate from TypeScript](docs/integrations/typescript.md).
- [Documentation index](docs/index.md) and [agent documentation map](llms.txt).

For coding agents, discover the installed command contract before writing a request:

```bash
attest help agent add --output json
attest schema print attest.command-request --output json
attest errors --output json
```

Read `error.code` and the process exit code. An evaluation that completes with a
failing score returns `ok: true`, `verdict: "fail"`, and exit code `1`.

## Local files and execution

Commit `attest.project.json` and the authored resources under `attest/` with your
tests. Runs live in `.attest/runs.db`; keep `.attest/` out of version control. Reports
and run data can contain agent inputs, outputs, and traces.

Attest runs the processes and requests configured in your project. Use projects and
agent commands you trust. Evaluation data stays in the local store, while configured
HTTP agents and model judges communicate with their providers. Attest sends no usage
telemetry. See the [telemetry policy](docs/TELEMETRY.md).

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workspace layout, development commands,
and required checks. Report alpha failures with the Attest version, OS, command,
exit code, and a minimal redacted input that reproduces the issue.

Licensed under [Apache-2.0](LICENSE).
