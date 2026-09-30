# CLI guide

This page maps each workflow to its guide and holds the rules every command shares. Structured
help is the exact contract for the installed version.

## Discover commands without prose

```bash
attest help --output json
attest help agent add --output json
attest schema print attest.command-request --output json
attest errors --output json
```

Structured help returns `attest.cli-help`. It lists arguments, options, defaults, conflicts,
implied flags, the request schema id, examples, aliases, and constraints.
`schema print` returns the generated schema requested by id. `errors` returns the
`attest.cli-errors` registry. These read-only commands do not create a project or a
run database.

## Workflow map

| Goal                        | Canonical guide                                 | Primary commands                                                           |
| --------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| Create or inspect a project | [Resource model](../concepts/resource-model.md) | `attest project init`, `attest project show`, `attest project validate`    |
| Connect and probe an agent  | [Agents](./agents.md)                           | `attest agent add`, `attest agent import`, `attest agent test`             |
| Add cases or datasets       | [Tests and datasets](./tests-and-datasets.md)   | `attest test add`, `attest test case import`, `attest test dataset import` |
| Define scoring              | [Metrics](./metrics.md)                         | `attest metric add`, `attest metric import`, `attest metric test`          |
| Execute and inspect         | [Evaluation runs](./eval-runs.md)               | `attest eval run`, `attest eval cancel`, `attest diff`, `attest report`    |
| Diagnose a failure          | [Error catalog](../reference/errors.md)         | `attest errors --output json`                                              |

There are no plural namespace aliases. `attest init` is the only convenience alias and
maps to `attest project init`. The removed `attest run` spelling is not accepted; use
`attest eval run`.

## Machine output

`--output json` prints one [`attest.cli-result`](../reference/schemas.md#attestcli-result)
document on stdout. `attest eval run` also accepts `--output jsonl`, which prints one
[`attest.cli-event`](../reference/schemas.md#attestcli-event) per line and ends with a `result`
event.

## Prompts and non-interactive runs

A command prompts only when stdin and stdout are TTYs, output is `human`, CI is not detected, and
neither `--non-interactive` nor `--from-json` is present. `--output json` implies
`--non-interactive`. Without prompts, missing required input fails with `cli_missing_input`
(exit 2), and conflicting flags or an invalid value fail with `cli_usage` (exit 2).

## Mutation controls

Every authoring mutation accepts these flags:

```text
--dry-run                    validate and return the semantic diff without writing
--yes                        accept confirmation; never invent missing values
--from-json <path|->         read one attest.command-request document
--if-project-hash <sha256>   reject a stale write instead of overwriting it
```

`--yes` accepts the confirmation prompt. It never fills in a missing id, command, URL, mapping, or
secret reference. `--dry-run` returns the same semantic diff without taking the lock, writing a
journal, or touching files.

`--from-json -` reads the request from stdin. A request must carry the whole command, so it
conflicts with positional values and authoring flags. Print its schema with
`attest schema print attest.command-request --output json`.

Pass `--if-project-hash` the `project_hash_after` from a prior read or mutation. A mismatch fails
with `project_changed` (exit 3). Reload the project, rebuild the request, then retry.

## Rename and remove

`rename` updates every reference to the resource in one transaction. `remove` fails while anything
references the resource. `agent remove --detach` also removes the tests that use the agent.
`metric remove --detach` removes every test and case reference to the metric.

```sh
attest agent rename support support-renamed --dry-run
attest agent remove support-renamed --detach --yes --output json
attest metric remove exact --detach --yes --output json
```

## Project and inspection commands

```text
attest project init [directory] [--name <name>]
attest project show
attest project validate
attest list agents|tests|datasets|metrics|runs
attest show agent|test|dataset|metric|run <id>
attest schema list
attest schema print <schema-id>
attest errors [--output human|json]
```

For a working end-to-end sequence, use the [quickstart](../quickstart.md). For canonical
paths and references, use the [resource model](../concepts/resource-model.md).

## Integration transports

- [Native](../integrations/native.md)
- [cURL and HTTP](../integrations/curl-and-http.md)
- [Managed CLI processes](../integrations/cli-processes.md)
- [Polling and streams](../integrations/polling-and-streams.md)
- [WebSockets](../integrations/websockets.md)

Every transport carries the [agent protocol](../specs/agent-contract.md). Executable metrics use
the [metric protocol](../specs/metric-contract.md).
