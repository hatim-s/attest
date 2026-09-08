# Agent-readable missing-input repair

This minimal flow shows a coding agent how to discover the `agent add` contract,
trigger a deliberate missing-input error, and identify the safe repair without
guessing at files or flags. Run the commands from a clean copy of this directory with
the packed `attest` executable on `PATH`.

See the [setup instructions](../../README.md#try-it-from-source) to build or install
the CLI. With a local archive installation, run in that installation directory and
replace `attest` with `npx attest` below.

## Inspect the contract

Read the command help, request schema, and error registry before mutating a
project:

```bash
attest help agent add --output json
attest schema print attest.command-request --output json
attest errors --output json
```

These inspection commands are read-only and do not create `attest.project.json` or
`.attest/runs.db`.

## Create the repair workspace

```bash
attest project init . --name repair --non-interactive --output json
```

## Trigger the deliberate failure

```bash
attest agent add incomplete --output json
```

The command exits with code `2` and returns an `attest.cli-result` failure whose
command is `agent.add` and whose error code is `cli_missing_input`. It does not write
`attest/agents/incomplete.json` or `.attest/runs.db`.

## Repair rule

Treat the structured error together with the previously fetched JSON help and
`attest.command-request` schema as the source of truth. Supply one complete
transport configuration described there, then retry the same agent id. Because the
failed transaction wrote no agent resource, the retry starts from a clean project
state and needs no rollback.

## Cleanup

Discard the working copy after inspection. This example intentionally has no seed
files or external dependencies.
