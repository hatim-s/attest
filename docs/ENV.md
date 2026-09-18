# Environment variables

Attest passes a minimal environment to eval lifecycle hooks. Every hook receives
`ATTEST_PROJECT_ROOT` and `ATTEST_RUN_ID`. Case hooks also receive `ATTEST_TEST_ID`,
`ATTEST_CASE_ID` and `ATTEST_WORKER_INDEX`. When explicit workers are configured, case hooks also
receive `ATTEST_WORKER_DIRECTORY`. `after_case` receives
`ATTEST_CASE_OUTCOME`; `after_run` receives `ATTEST_RUN_STATUS` and the JSON-encoded
`ATTEST_RUN_SUMMARY`.

These values describe the current run. They are not user-configured secrets.
