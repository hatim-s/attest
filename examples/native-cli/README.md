# Native CLI authoring and evaluation

This minimal project exercises the complete local authoring path with Attest's native
stdin/stdout agent protocol. Run the commands from this directory with the packed
`attest` executable on `PATH`.

## Prerequisites

- Node.js is available as `node`.
- The packed Attest CLI is available as `attest`.
- The working directory is a clean copy of this example.

## Author and evaluate

Initialize the project:

```bash
attest project init . --name support --non-interactive --output json
```

Register and probe the checked-in native agent:

```bash
attest agent add support --argv-json '["node","./agent.mjs"]' --timeout 5s --output json
attest agent test support --input '"ping"' --output json
```

Add an exact-output metric, create a test, and import the checked-in case:

```bash
attest metric add exact --preset output-equals --value '"refund policy"' --output json
attest test add smoke --agent support --metric exact --output json
attest test case import smoke ./cases.jsonl --output json
```

Run the evaluation:

```bash
attest eval run smoke --output json
```

Every command writes one `attest.cli-result/v1` JSON document to stdout. The final
command creates `.attest/runs.db`; the authoring commands create the project manifest
and resources under `attest/`.

## Cleanup

Discard the working copy. The checked-in `agent.mjs` and `cases.jsonl` files are the
only seed files required to repeat the example in another clean directory.
