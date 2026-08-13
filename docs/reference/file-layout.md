# File layout

An Attest project separates inspectable authored resources from local runtime state:

```text
project/
├── attest.project.json
├── attest/
│   ├── agents/
│   │   └── <agent-id>.json
│   ├── tests/
│   │   └── <test-id>.json
│   ├── metrics/
│   │   └── <metric-id>.json
│   └── datasets/
│       ├── <dataset-id>.jsonl
│       └── <dataset-id>.meta.json
└── .attest/
    ├── runs.db
    ├── project.lock
    ├── transactions/
    │   └── <transaction-id>/
    │       └── journal.json
    └── eval-runs/
        ├── <run-id>.json
        └── <run-id>.cancel.json
```

Only paths needed by current activity exist. `project init` initially writes only
`attest.project.json`; authoring creates resource directories as needed, and the first recorded
probe or evaluation creates `.attest/runs.db`.

## `attest.project.json`

This generated `attest.project` manifest is the project discovery root and content-addressed
index. It contains the project id/name/defaults and deterministic lists of agents, tests, datasets,
and metrics. Non-dataset entries contain id, schema, canonical path, and content hash. Dataset
entries separately bind JSONL data and metadata paths/hashes.

The canonical paths are fixed:

- `attest/agents/<id>.json`
- `attest/tests/<id>.json`
- `attest/metrics/<id>.json`
- `attest/datasets/<id>.jsonl`
- `attest/datasets/<id>.meta.json`

Project discovery walks parent directories only within its allowed filesystem boundary. Pass
`--project <dir>` to choose an explicit root.

## Authored resource files

### Agents

`attest/agents/<id>.json` is one strict `attest.agent` resource. It describes exactly one
transport, lifecycle, capabilities, retry/time/limit policies, extraction, redaction, and
environment-variable references. Secret values are not an authored format.

### Tests and direct cases

`attest/tests/<id>.json` is one strict `attest.test` resource. It contains its agent reference,
metric references, direct `attest.case` objects, and dataset attachments. Direct cases remain in
this JSON resource; they are not separate files.

### Metrics

`attest/metrics/<id>.json` is one strict `attest.metric` assertion, judge, executable, or HTTP
definition. Test-specific metric thresholds are references in the test resource.

### Datasets

`attest/datasets/<id>.jsonl` stores one canonical `attest.case` object per line in deterministic
order. `attest/datasets/<id>.meta.json` stores the `attest.dataset` identity, case count, case
schema, name, and import provenance: source type/content hash, mappings, optional key field, real
import timestamp, and read/insert/update/skip counts.

Generated case ids exclude dataset identity, so the same logical case remains stable across direct
case/dataset moves and dataset renames. The project reproducibility hash ignores only the volatile
dataset `imported_at` value; the persisted metadata integrity hash still protects the exact metadata
file, including that timestamp.

## Local runtime state

`.attest/` is local operational state, not an authored resource tree.

### Run store

`.attest/runs.db` is the SQLite store for recorded agent probes and evaluation runs. SQLite may
create `runs.db-wal` and `runs.db-shm` while open. Eval persistence records immutable run metadata,
case attempts, raw normalized evidence, metric evaluations, lifecycle state, and summary.

`attest eval run`, `attest agent test --record`, `attest diff`, `attest report`, and `attest view`
use this store. The read surfaces accept `--store <path>`; the eval writer is project-local and
validates that `.attest` and the database are not unsafe symlink escapes.

### Mutation lock

`.attest/project.lock` is an exclusive `attest.project-lock` record containing hostname, pid,
process-start identity, creation time, and an unguessable owner token. Writers never steal an
existing lock. A live lock means wait; an unprovable or malformed lock is not safe to delete. The
fixed-base CLI can classify a proven-stale lock but does not register a `project unlock` command,
so automated repair must stop for a human rather than deleting it directly.

Dry runs do not create `.attest`, acquire this lock, recover journals, or write files.

### Transaction journals

`.attest/transactions/<transaction-id>/journal.json` is a durable
`attest.project-transaction` recovery record. Its directory may also contain exact backups and
staged next bytes. Resource files publish before the manifest, so the manifest is the commit point.
A later mutation/read that permits recovery either completes a manifest-committed transaction or
rolls back a pre-manifest transaction when ownership can be proven.

Do not delete or edit a journal after `project_recovery_required`. Preserve the entire transaction
directory and reconcile the source-addressed paths with a human.

### Eval cancellation registry

While a run is active, `.attest/eval-runs/<run-id>.json` records its pid, run id, and private token.
A separate `attest eval cancel` process atomically publishes
`<run-id>.cancel.json` containing that authenticated token. The runner polls only its own request,
cancels adapters, and removes owned registry files at termination. Stale/unowned uncertainty is
reported; unrelated processes are never signalled.

## Output artifacts

Artifacts selected by a caller are outside the fixed authored tree:

- `attest eval run --junit <path>` writes JUnit XML atomically.
- `attest report <run-id> --output <path>` writes a self-contained HTML report and refuses to
  replace it without `--force`.
- `attest trace convert <input> --output <path>` writes normalized `attest.trace` JSON and
  also refuses replacement without `--force`.
- `attest view` serves a read snapshot; it does not author project resources.

These paths are not added to `attest.project.json` and do not affect the project hash.

## Integrity and mutation rules

1. Use CLI authoring commands as the documented write path. Hand-editing requires updating exact
   generated hashes and can make the entire project invalid.
2. Treat `attest.project.json` as generated. Resource ids and paths must agree with its entries.
3. A mutation is atomic across every affected resource and the manifest. On validation, hash, or
   publication failure, no partial candidate becomes the new project.
4. Use `--dry-run` to inspect semantic operations and `--if-project-hash <sha256>` to bind a later
   write to the state that was reviewed.
5. Never delete a live lock, a transaction journal that needs human recovery, SQLite sidecars while
   the store is open, or an active eval registry file.

Inspect safely with:

```sh
attest project show --output json
attest project validate --output json
attest list agents --output json
attest list tests --output json
attest list datasets --output json
attest list metrics --output json
```

See [Schemas](./schemas.md), [Errors](./errors.md), and [Exit codes](./exit-codes.md).
