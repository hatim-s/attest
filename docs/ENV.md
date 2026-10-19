# Environment variables

Attest passes a minimal environment to eval lifecycle hooks. Every hook receives
`ATTEST_PROJECT_ROOT` and `ATTEST_RUN_ID`. Case hooks also receive `ATTEST_TEST_ID`,
`ATTEST_CASE_ID` and `ATTEST_WORKER_INDEX`. When explicit workers are configured, case hooks also
receive `ATTEST_WORKER_DIRECTORY`. `after_case` receives
`ATTEST_CASE_OUTCOME`; `after_run` receives `ATTEST_RUN_STATUS` and the JSON-encoded
`ATTEST_RUN_SUMMARY`.

These values describe the current run. They are not user-configured secrets.

## Vercel Sandbox credentials

A `native_cli` agent with `sandbox.kind` set to `vercel` creates a remote Vercel Sandbox even
when Attest itself runs on a developer machine. It is not a local or offline sandbox.

Use one of these credential routes in the environment of the `attest` process:

- `VERCEL_OIDC_TOKEN`
- `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` together

The three variables in the second route form one credential set. Attest rejects an incomplete set.
Do not put credential values in `attest/agents/*.json`, `--sandbox-json`, argv, or checked-in shell
scripts.

The `after_agent` and `after_evaluation` command hooks receive the same case identifiers, worker directory, and `ATTEST_CASE_OUTCOME` as `after_case`. `after_agent` runs before metric evaluation, and `after_evaluation` runs after metrics.

## CLI and model providers

`CI=true` disables prompts. Other values do not. Prompts also require human output,
input/output TTYs, no `--from-json`, and no `--non-interactive`.

The TanStack judge adapters use `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` for their
respective providers when no explicit SDK key is supplied. Agent processes do not
inherit provider secrets automatically. Explicit `from_env` mappings resolve named
host variables for configured secret fields; process environment allowlists opt in
host values. Never put the secret value in an authored resource.

## Native process environment

Native CLI invocations receive `ATTEST_PROTOCOL`, `ATTEST_RUN_ID`, and `ATTEST_CASE_ID`.
These identifiers override allowlisted host values. By default `HOME` and `TMPDIR`
point inside the attempt directory, `LC_ALL` is `C`, and `PATH` contains only absolute
host entries. Explicit allowlisting can replace these environment defaults.

## Attest home directory

`ATTEST_HOME` overrides the `~/.attest` directory. When it is set, Attest reads the project
registry from `<ATTEST_HOME>/projects.json` and the cloud credentials from
`<ATTEST_HOME>/cloud/credentials.json`. When it is unset, both live under `~/.attest`.
See [file layout](reference/file-layout.md#project-registry).

## Cloud credentials

Cloud login takes its URL explicitly and saves credentials in
`~/.attest/cloud/credentials.json`, or under `ATTEST_HOME` when it is set. The local
cloud adapter defines no URL/token environment variable. See
[cloud commands](cli/cloud.md).

## Developer controls

`FUZZ=1` enables conformance fuzz tests. `FUZZ_ITERATIONS` overrides their iteration
count. The `test:fuzz` script enables `FUZZ` itself. Telemetry opt-outs described in
[the telemetry policy](TELEMETRY.md) are requirements for a future change, not current switches.
