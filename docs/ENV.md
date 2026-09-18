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
