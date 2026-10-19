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

Structured help puts an `attest.cli-help` document in the `attest.cli-result` envelope's
`result` field. It describes arguments, options, defaults, conflicts, implied flags,
request schema ids, examples, and aliases. `schema print` puts the generated JSON Schema
in `result.schema`; `errors` puts the `attest.cli-errors` registry in `result`. These read-only commands do not create a project or a
run database.

## Workflow map

| Goal                        | Canonical guide                                                   | Primary commands                                                                     |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Create or inspect a project | [Resource model](../concepts/resource-model.md)                   | `attest project init`, `attest project show`, `attest project validate`              |
| Register projects           | [Project registry and dashboard](#project-registry-and-dashboard) | `attest projects list`, `attest projects add`, `attest projects remove`              |
| Connect and probe an agent  | [Agents](./agents.md)                                             | `attest agent add`, `attest agent import`, `attest agent test`                       |
| Add cases or datasets       | [Tests and datasets](./tests-and-datasets.md)                     | `attest test add`, `attest test case import`, `attest test dataset import`           |
| Define scoring              | [Metrics](./metrics.md)                                           | `attest metric add`, `attest metric import`, `attest metric test`                    |
| Execute and inspect         | [Evaluation runs](./eval-runs.md)                                 | `attest eval run`, `attest eval cancel`, `attest diff`, `attest report`              |
| Run in the cloud            | [Cloud commands](./cloud.md)                                      | `attest cloud login`, `attest cloud push`, `attest cloud run`, `attest cloud events` |
| Diagnose a failure          | [Error catalog](../reference/errors.md)                           | `attest errors --output json`                                                        |

There are no plural namespace aliases. `attest init` is the only convenience alias and
maps to `attest project init`. The removed `attest run` spelling is not accepted; use
`attest eval run`.

## Global machine contract

Use `--output json` on discovery, project, resource, and eval commands for exactly one
`attest.cli-result` document on stdout. Unknown commands and invalid options also return
this envelope when JSON output is requested. A success
document contains `ok: true`, `command`, `project_hash_before`, `project_hash_after`, a
command-specific `result`, and `warnings`. A failure document contains `ok: false`,
`command`, and `error`, whose stable fields include `code`, `message`, and `retryable`.

Commands that support streaming accept `--output jsonl`. Every line is one
`attest.cli-event` document with `sequence`, `time`, `event`, and `data`; the final
line has `event: "result"`. Parser and preflight failures produce one result event at
sequence `0`, with `data.exit_code` and a failure envelope in `data.result`. See [evaluation lifecycle](../concepts/eval-lifecycle.md)
and [schemas](../reference/schemas.md).

Structured output implies non-interactive operation. Missing required input returns the
stable `cli_missing_input` error instead of prompting. For explicit non-interactive human
output, add `--non-interactive`.

The artifact commands have separate output options. `diff --format json` emits a raw
diff document. `report --output <path>` and `trace convert --output <path>` select files;
without a path, `trace convert` prints the raw trace document. `view` prints its local
URL and stays running. The root `--output json` flag does not change these commands.
`--help` and `--version` retain terminal text; use `attest help --output json` for discovery.

## Prompts and non-interactive runs

Prompts require human output, both input and output TTYs, no `--from-json`, no
`--non-interactive`, and `CI` other than the exact string `true`. Structured output
never prompts. Supply missing values explicitly for automation.

## Rename and remove

```text
attest agent rename <id> <new-id>
attest agent remove <id>
attest metric rename <id> <new-id>
attest metric remove <id> [--detach]
attest test rename <id> <new-id>
attest test remove <id>
attest test case rename <test-id> <case-id> <new-id>
attest test case remove <test-id> <case-id>
attest test dataset rename <id> <new-id>
attest test dataset remove <id>
```

Renames update references atomically. Removal rejects referenced agents, metrics,
and datasets with reference blockers. Read the returned detach commands; metric
removal also supports explicit `--detach`. These commands share the mutation
controls below. A dry-run does not rename anything, so subsequent commands must
still use the original id until the rename is committed.

## Mutation controls

All authored-resource mutations share these controls:

```text
--dry-run                    validate and return the semantic diff without writing
--yes                        accept confirmation; never invent missing values
--from-json <path|->         read one attest.command-request document
--if-project-hash <sha256>   reject a stale write instead of overwriting it
```

Use `--if-project-hash` with `project_hash_after` from a read or a committed mutation.
A dry-run's `project_hash_after` describes the proposed state; use its
`project_hash_before` when committing that proposal. A mismatch returns `project_changed`
and exit code `3`; refresh the project state and rebuild the request before retrying.

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

## Project registry and dashboard

Attest keeps one global registry of the local projects that use it, and can serve every
registered project from one dashboard process. The registry lives at
`~/.attest/projects.json`, or under `ATTEST_HOME` when that variable is set. See
[file layout](../reference/file-layout.md#project-registry) for the stored shape.

```text
attest projects list [--output human|json]
attest projects add [directory] [--name <name>]
attest projects remove <key-or-directory>
```

`attest project init` registers the project after it writes the manifest. A project that
predates the registry joins it with `attest projects add`, which defaults to `.`. The
manifest supplies the name and project id; without a manifest the name is the directory
basename, and `--name <name>` overrides it. Adding a root that is already registered
changes nothing and returns the existing entry.

If the registry cannot be written, `project init` keeps the manifest it already wrote and
reports the failure with the `attest projects add <dir>` command to run instead.

`attest view` inside a project serves that one project. `attest view --all` serves every
registered project instead, and cannot be combined with `--store`.

```sh
attest projects add ~/Projects/workflow-code --output json
attest view --all --no-open
```

A registered project whose `.attest/runs.db` does not exist yet appears with no runs.
Serving it does not create the store; the first recorded probe or evaluation creates it.

## Integration transports

- [Native](../integrations/native.md)
- [cURL and HTTP](../integrations/curl-and-http.md)
- [Managed CLI processes](../integrations/cli-processes.md)
- [Polling and streams](../integrations/polling-and-streams.md)
- [WebSockets](../integrations/websockets.md)

Each transport ultimately exchanges the
[agent protocol](../specs/agent-contract.md); executable metrics use the
[metric protocol](../specs/metric-contract.md).
