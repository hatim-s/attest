# Resource model

Attest keeps authored intent in reviewable files and execution history in a separate
local run store. The project manifest indexes four reusable resource types: agents,
tests, datasets, and metrics.

## Project manifest

`attest.project.json` is an `attest.project` document. It contains the project id and
name, optional execution defaults, and four resource lists. Each list entry records a
stable resource id, canonical project-relative path, schema id, and integrity hash.
Dataset entries separately hash metadata and JSONL data.

Initialize a manifest non-interactively with:

```bash
attest project init . --name support --non-interactive --output json
```

The command creates no run database. Use `attest project show --output json` to read the
resolved project and `attest project validate --output json` to check schemas,
references, hashes, canonical paths, and duplicate ids.

## Authored resources

| Resource         | Schema           | Canonical path                   | Purpose                                                                    |
| ---------------- | ---------------- | -------------------------------- | -------------------------------------------------------------------------- |
| Agent            | `attest.agent`   | `attest/agents/<id>.json`        | Transport and invocation policy for one reusable agent                     |
| Test             | `attest.test`    | `attest/tests/<id>.json`         | Agent reference, direct cases, dataset attachments, metrics, and pass gate |
| Dataset metadata | `attest.dataset` | `attest/datasets/<id>.meta.json` | Dataset identity, case schema, provenance, and row count                   |
| Dataset cases    | `attest.case`    | `attest/datasets/<id>.jsonl`     | One case document per line                                                 |
| Metric           | `attest.metric`  | `attest/metrics/<id>.json`       | Assertion, judge, executable, or HTTP scoring definition                   |

Ids use lower-case kebab case and are unique within a resource type. References use ids,
not filesystem paths: a test names one `agent_id`, attaches datasets by `dataset_id`, and
attaches metrics by `metric_id`. Renames and removals therefore validate or update the
whole reference graph atomically.

Use the focused guides for [agents](../cli/agents.md),
[tests and datasets](../cli/tests-and-datasets.md), and [metrics](../cli/metrics.md).

## Cases and datasets

A test may contain direct cases and attach reusable datasets. Every case has an id and
JSON-valued `input`; it may also define JSON-valued `expected`, parameters, tags, and
per-case metric overrides. Direct cases are convenient for small sets. Imports above
100 direct cases remain valid but warn that a named dataset is easier to reuse.

A dataset separates `attest.dataset` metadata from `attest.case` JSONL rows. Its
provenance can record source type, field mapping, source hash, key field, import time,
and read/insert/update/skip counts. Generated case ids exclude dataset identity, so an
unchanged source row keeps its id when the dataset moves.

## Authored state versus run state

Authored files describe what should run. `.attest/runs.db` stores immutable evaluation
records describing what did run. The database is created by `attest eval run`, not by
project or resource authoring. An eval run is not an authored resource and cannot be
edited through resource commands.

Each run snapshots resolved resource content hashes, selected tests and cases, effective
settings, attempts, metric results, and command metadata. This preserves historical
meaning when authored files change later. See the
[evaluation lifecycle](./eval-lifecycle.md) and [run-bundle specification](../specs/run-bundle.md).

## Safe mutations

Resource commands discover the project, lock it, read and hash current state, build and
validate a complete candidate, calculate a semantic diff, then either return the dry run
or atomically publish staged files. The manifest is the commit point.

Useful controls are:

```text
--dry-run                    return the semantic diff and write nothing
--from-json <path|->         read an attest.command-request document
--if-project-hash <sha256>   reject the mutation if the project changed
```

For coding agents, retain `project_hash_after` from the last successful
`attest.cli-result` document and pass it to the next mutation. A stale hash returns
`project_changed`, exit code `3`, and current-state repair context rather than
overwriting another actor's work.

## Schemas are the shape authority

The generated Draft 2020-12 schemas live in `packages/schemas/generated/` and are built
from the runtime definitions. Discover them without browsing the repository:

```bash
attest schema list --output json
attest schema print attest.project --output json
attest schema print attest.agent --output json
attest schema print attest.test --output json
attest schema print attest.dataset --output json
attest schema print attest.metric --output json
attest schema print attest.command-request --output json
```

The [schema reference](../reference/schemas.md) maps all ids to files, including
`attest.cli-result`, `attest.cli-event`, `attest.agent-invocation`,
`attest.metric-evaluation`, and `attest.trace`. Runtime validation additionally
enforces invariants that JSON Schema alone cannot express, such as reference resolution,
canonical paths, hash integrity, and collision checks.

## Execution

Attest uses one project manifest plus reusable resource files and runs tests only with
`attest eval run`. There is no top-level `attest run` alias.
