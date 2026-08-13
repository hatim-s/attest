# CLI guide

The Attest CLI separates authored resources from immutable evaluation records. Use this
page to find the canonical workflow, then use structured help for the exact installed
command contract.

## Discover commands without prose

```bash
attest help --output json
attest help agent add --output json
attest schema print attest.command-request --output json
attest errors --output json
```

Structured help returns `attest.cli-help`; it describes arguments, options, defaults,
conflicts, implied flags, request schema ids, examples, aliases, and deprecations.
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

## Global machine contract

Use `--output json` for exactly one `attest.cli-result` document on stdout. A success
document contains `ok: true`, `command`, `project_hash_before`, `project_hash_after`, a
command-specific `result`, and `warnings`. A failure document contains `ok: false`,
`command`, and `error`, whose stable fields include `code`, `message`, and `retryable`.

Commands that support streaming accept `--output jsonl`. Every line is one
`attest.cli-event` document with `sequence`, `time`, `event`, and `data`; the final
line has `event: "result"`. See [evaluation lifecycle](../concepts/eval-lifecycle.md)
and [schemas](../reference/schemas.md).

Structured output implies non-interactive operation. Missing required input returns the
stable `cli_missing_input` error instead of prompting. For explicit non-interactive human
output, add `--non-interactive`.

## Mutation controls

All authored-resource mutations share these controls:

```text
--dry-run                    validate and return the semantic diff without writing
--yes                        accept confirmation; never invent missing values
--from-json <path|->         read one attest.command-request document
--if-project-hash <sha256>   reject a stale write instead of overwriting it
```

Use `--if-project-hash` with the hash returned by the prior read or mutation. A mismatch
returns `project_changed` and exit code `3`; refresh the project state and rebuild the
request before retrying.

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

Each transport ultimately exchanges the
[agent protocol](../specs/agent-contract.md); executable metrics use the
[metric protocol](../specs/metric-contract.md).
