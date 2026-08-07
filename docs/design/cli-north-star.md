# CLI North Star

Status: proposed breaking v2 design contract Scope: local CLI and local files only Audience: implementers, documentation authors, humans using a terminal, and coding agents

## 1. Decision summary

Attest v2 is a CLI-authored, file-backed evaluation system. A user should be able to connect an agent, add a test and metric, import cases, and run an evaluation without learning Attest's JSON or YAML representation.

The product hierarchy is:

```text
project (the Attest unit rooted in one directory)
├── agents
├── tests
│   ├── direct test cases
│   └── attached datasets
│       └── test cases
├── datasets
├── metrics
└── eval runs
    └── immutable case attempts and metric results
```

The following decisions are normative for v2:

1. **Project is the user-facing name for the Attest unit.** “Unit” is explanatory language, not a second resource or command namespace.
2. **`eval` is an execution namespace, not an authored/stored definition noun.** `attest eval run` executes one or more tests and persists an immutable `eval_run`. There is no `attest eval add`.
3. **Tests replace v1 suites.** A test binds one agent, cases or datasets, metrics, and run defaults.
4. **Datasets are project resources.** The nested `attest test dataset ...` commands create or attach them in the context where users need them; a dataset may be attached to more than one test.
5. **All authoring operations have interactive and non-interactive forms.** Missing required values start a wizard only on a TTY unless `--non-interactive` is set. The same operation can always be expressed using flags or one JSON request document.
6. **Users do not have to author YAML or JSON directly.** Attest owns canonical, inspectable JSON resource files and JSONL dataset files. The CLI is the supported mutation API; JSON Schema is the supported integration contract.
7. **Every mutation supports a preview and is atomic.** `--dry-run` validates the complete proposed project, reports a semantic diff, and writes nothing. A successful non-dry run either publishes the entire transaction or restores the prior state.
8. **Human output and machine output have parity.** Every command supports `--output human|json`; streaming commands additionally support `jsonl`. JSON stdout is one versioned result envelope, progress goes to stderr, and secrets are never rendered.
9. **v2 intentionally breaks v1 config and command contracts.** Execution does not discover or run `attest.config.yaml`, `.yml`, or `.json`. There is no permanent compatibility parser. A narrow, explicit, non-destructive v1 import is described in [Section 12](#12-breaking-v2-and-v1-stance).
10. **This initiative is CLI-first and local-only.** A web editor, hosted control plane, accounts, remote persistence, cloud secrets, and cloud execution are explicitly out of scope.

## 2. Source-grounded starting point

This design preserves useful runtime contracts while replacing the authoring surface:

| Current source | Contract worth retaining | v2 change |
| --- | --- | --- |
| `packages/cli/src/run-cli.ts` | Commander command tree, JSON run output, local run/diff/report/view operations | Replace top-level authoring and `run` grammar; make every command share one output/error contract |
| `packages/contracts/src/config.ts` | Strict validation, aggregated cross-reference checks, typed agent/case/run settings | Split one `config_version: 1` document into versioned project resources |
| `packages/cli/src/config/load-config.ts` | Validate before execution, canonical hashing, explicit path resolution | Discover a project root and load its generated manifest; no v1 YAML/JSON discovery |
| `packages/core/src/runner/invoke.ts` | Validated envelopes, bounded evidence, invocation-error-only retries | Add transports behind the same invocation result boundary |
| `packages/core/src/runner/dataset.ts` | Full-file validation and line-aware diagnostics before invoking an agent | Generalize from JSONL-only loading to transactional CSV/JSON/JSONL import |
| `docs/specs/agent-contract.md` | Native request/response envelopes, timeouts, output caps, error classification | Keep as the native adapter and define lifecycle/extraction for imported integrations |
| `docs/specs/metric-contract.md` | Assertion, executable/HTTP, judge, and trace/tool metric semantics | Make CLI wizards and importers produce those definitions |
| `packages/core/src/store/` | Immutable completed runs, attempts, summaries, diffs, run bundles | Rename the user-facing record to eval run without forcing a storage rewrite |

Current v1 has `attest init`, `run`, `diff`, `view`, `report`, and `trace convert`; it supports one agent per config, suites with inline cases or one JSONL dataset, CLI/HTTP invocation, and assertion/exec/judge metrics. It does not provide resource CRUD, CSV/JSON import, streaming agent transports, transactional multi-file authoring, or uniform structured errors. Those gaps are the scope of this design.

## 3. Resource model and identity

### 3.1 Project

A project is the directory tree rooted by `attest.project.json`. Commands search the current directory and then parents unless `--project <path>` is supplied. Project discovery never crosses a filesystem mount boundary or a Git worktree root unless the explicit path does.

The project owns:

- `project_id`: generated ULID, stable across directory renames.
- `name`: human-readable name; defaults to the directory name.
- resource manifests and content hashes.
- project defaults such as concurrency, output cap, and default eval timeout.
- the local run store, `.attest/runs.db`, which remains ignored by Git.

Canonical authored files are committed:

```text
attest.project.json
attest/
├── agents/<agent-id>.json
├── tests/<test-id>.json
├── datasets/<dataset-id>.jsonl
├── datasets/<dataset-id>.meta.json
└── metrics/<metric-id>.json
```

`attest.project.json` is a generated index of resource ids, relative paths, schema versions, and content hashes. It contains no secret values. File layout is an implementation detail exposed for inspection and Git diffing; callers must use the CLI or published schemas rather than depend on key ordering or comments.

### 3.2 Agents

An agent is a named invocation adapter. It specifies a transport, lifecycle, request construction, response/event extraction, timeout policy, retry policy, and references to host-provided secrets. One agent may be reused by many tests.

Agent ids, test ids, dataset ids, and metric ids are lowercase slugs matching `[a-z][a-z0-9]*(?:-[a-z0-9]+)*`. Rename is an explicit operation that updates references in one transaction. Names are mutable display labels; ids are stable references.

### 3.3 Tests, test cases, and datasets

A test is an executable evaluation definition:

- exactly one agent reference;
- zero or more direct cases;
- zero or more dataset attachments;
- one or more metric references, with optional per-case overrides;
- optional concurrency, timeout, retry, and pass-gate overrides.

A test case contains `id`, `input`, and optional `expected`, `params`, `tags`, and metric overrides. Direct cases are stored in the test resource. Dataset cases use the same logical schema but live in the dataset JSONL file.

A dataset is a reusable, ordered collection of test cases plus import provenance. Attaching a dataset to a test does not copy its rows. A test may filter an attachment by tags, but v2 does not define arbitrary query expressions.

Case ids are unique within a test after resolving all direct cases and attached datasets. A dataset may contain the same case id as another dataset; attaching both to one test is rejected with all collisions reported before execution.

### 3.4 Metrics

A metric is a reusable project resource with one of these kinds:

- `assertion`: deterministic output, expected-value, JSON Schema, threshold, trace, or tool checks;
- `judge`: model plus rubric and threshold;
- `exec`: trusted local executable using `attest.metric/v1alpha1`;
- `http`: trusted HTTP metric using the same envelope.

The underlying result remains `{score, pass, rationale?, details?}`. A metric failure and a metric execution error remain distinct.

### 3.5 Eval runs

`attest eval run` resolves selected tests into a snapshot, executes them, and persists an immutable eval run. It records project/resource content hashes, selected test and case ids, invocation attempts, metric results, Git metadata when available, timestamps, and the effective command.

“Run” alone means the execution record in prose. `eval_run` is the machine type. An eval run is not an authored resource and cannot be added or edited. Existing diff, report, view, and bundle behavior continues to consume these records.

## 4. Command grammar

### 4.1 Common grammar

```text
attest [--project <dir>] [--output human|json] [--non-interactive] <namespace> <verb> ...
attest help [<namespace> [<verb> ...]] [--output human|json]
```

Common mutation flags:

```text
--dry-run                    validate and show the semantic diff; write nothing
--yes                        accept a confirmation without prompting
--from-json <path|->         read one versioned command request from a file or stdin
--if-project-hash <sha256>   fail if the project changed since the caller read it
```

`--non-interactive` disables prompts and fails with `cli_missing_input` if required data is absent. It is implied when stdin or stdout is not a TTY, when `--output json|jsonl` is selected, or when `CI=true`. `--yes` answers confirmation prompts but does not invent missing values.

There are no plural aliases and no one-letter namespace aliases. They are hard to discover, create ambiguous scripts, and save little typing. The only v2 compatibility aliases are listed below; help marks them deprecated and JSON help includes `alias_for` and `removal_version`.

### 4.2 Project and inspection

```text
attest project init [directory] [--name <name>]
attest project show
attest project validate
attest project migrate-v1 --from <attest.config.*> [--into <directory>]
attest list agents|tests|datasets|metrics|runs
attest show agent|test|dataset|metric|run <id>
attest schema list
attest schema print <schema-id>
attest errors [--output human|json]
```

`attest init` is an alias for `attest project init` through the v2 preview period. `list` and `show` are generic read-only commands so CRUD namespaces do not each grow slightly different inspection verbs.

### 4.3 Agent commands

```text
attest agent add <agent-id> [transport flags]
attest agent import <path|url|-> [--as <agent-id>] [--type curl|json]
attest agent test <agent-id> [--input <json>] [--input-file <path>] [--watch]
attest agent rename <agent-id> <new-id>
attest agent remove <agent-id> [--detach]
```

`agent add` opens the transport wizard when transport flags are absent. The fully non-interactive forms include:

```bash
attest agent add support --native-command 'node ./src/agent.mjs' --timeout 60s
attest agent import request.curl --type curl --as support --response-pointer /answer
attest agent test support --input '{"question":"ping"}' --output json
```

Command strings are tokenized by Attest for convenience and stored as an argv array; they are never passed through a shell. `--argv-json '["node","./src/agent.mjs"]'` is the unambiguous form. `agent test` performs one contract probe without creating an eval run unless `--record` is supplied.

### 4.4 Test, case, and dataset commands

```text
attest test add <test-id> --agent <agent-id> [--metric <metric-id> ...]
attest test case add <test-id> [case flags]
attest test case import <test-id> <path|-> [import flags]
attest test dataset add <test-id> <dataset-id> [--name <name>]
attest test dataset import <test-id> <path|-> --as <dataset-id> [import flags]
attest test dataset attach <test-id> <dataset-id> [--tag <tag> ...]
attest test dataset detach <test-id> <dataset-id>
attest test metric attach <test-id> <metric-id>
attest test metric detach <test-id> <metric-id>
attest test rename <test-id> <new-id>
attest test remove <test-id>
```

`test dataset add` creates an empty project dataset and attaches it to the test atomically. It fails if the dataset id already exists; use `attach` for an existing dataset. `test dataset import` creates, imports, and attaches in one transaction. `test case import` imports direct cases into the test; it is intended for small collections. The same input above 100 cases emits a warning recommending a dataset but remains valid.

Non-interactive case examples:

```bash
attest test add refund --agent support --metric correct --metric no-failed-tools
attest test case add refund --id refund-basic \
  --input '{"question":"How do refunds work?"}' \
  --expected '{"contains":"30 days"}'
attest test dataset import refund ./fixtures/refunds.csv --as refund-regression \
  --map input.question=prompt --map expected.answer=ideal_answer --key external_id
```

`--input`, `--expected`, and `--params` accept JSON scalar, array, or object values. Convenience flags such as `--input-text` are wizard sugar and normalize to the same JSON request.

### 4.5 Metric commands

```text
attest metric add <metric-id> [--preset <preset>] [metric flags]
attest metric import <path|url|-> [--as <metric-id>] [--type json|curl]
attest metric test <metric-id> --fixture <case-result.json>
attest metric rename <metric-id> <new-id>
attest metric remove <metric-id> [--detach]
```

Wizard presets are stable API values:

| Preset            | Produces                                                         |
| ----------------- | ---------------------------------------------------------------- |
| `output-equals`   | `equals` assertion against output or expected data               |
| `output-contains` | string or array containment assertion                            |
| `output-schema`   | Draft 2020-12 JSON Schema assertion                              |
| `judge-rubric`    | judge metric with rubric, model, and threshold                   |
| `command`         | executable metric with argv, timeout, and environment references |
| `http`            | HTTP executable metric with request/result mapping               |
| `tool-called`     | required tool name, optional count and argument matchers         |
| `tool-order`      | chronological tool-call assertion                                |
| `no-tool-errors`  | trace assertion rejecting failed tool spans                      |
| `trace-span`      | generic span filter/count/order assertion                        |

Examples:

```bash
attest metric add correct --preset judge-rubric \
  --model openai/gpt-5 --rubric-file ./rubrics/correctness.md --threshold 0.8
attest metric add searched --preset tool-called --tool search \
  --arg-contains /query=refund
attest metric add brand --preset command --argv-json '["python3","metrics/brand.py"]'
```

`metric import` accepts a v2 metric request or cURL for an HTTP metric. It does not infer a rubric or generate executable code. The wizard may offer templates, but every generated definition is shown before commit and has an equivalent documented request schema.

### 4.6 Evaluation and existing read surfaces

```text
attest eval run [<test-id> ...] [selection and execution flags]
attest eval cancel <run-id>
attest diff <base-run-id> <candidate-run-id>
attest report <run-id>
attest view
attest trace convert <input>
```

Important eval flags:

```text
--all                         run every test; required if no test ids are supplied non-interactively
--case <case-id>              select exact cases; repeatable
--tag <tag>                   select cases with all repeated tags
--concurrency <n>             override project/test defaults
--timeout <duration>          cap the whole eval run
--baseline <run-id>           include a persisted diff
--junit <path>                write JUnit atomically
--watch                       render live progress (human output only)
--output human|json|jsonl     final document or event stream
```

`attest run` is a deprecated alias for `attest eval run --all` only when no test id is supplied. It must not silently guess a test. Remove it at the first stable major version. `attest eval run` is the canonical spelling in docs, errors, telemetry, and stored command metadata.

With `--output json`, stdout contains one `attest.cli-result/v1` document after completion. With `jsonl`, each line is an `attest.cli-event/v1` document containing `sequence`, `time`, `event`, and `data`; the final line is `event: "result"`. Event order is deterministic for orchestration events, while case completion events retain actual completion order and carry their configured case index.

## 5. Interactive and agent-ergonomic parity

Every mutation has one versioned command request object. Flags and the wizard populate that same object, which then passes the same JSON Schema, semantic validation, reference checks, and conflict checks. Help names the request schema and gives a complete `--from-json` example.

Machine output is `attest.cli-result/v1`. Success contains `ok: true`, `command`, `project_hash_before`, `project_hash_after`, a command-specific `result`, and `warnings`. Failure contains `ok: false`, `command`, and `error: {code, message, path?, hint?, retryable, details?}`. In JSON mode the envelope goes to stdout; otherwise errors go to stderr. This shape is published as JSON Schema and tested as a compatibility contract.

Exit codes are stable: `0` success, `1` evaluated failure or user-data validation failure, `2` CLI usage error, `3` project conflict/stale hash, `4` invocation or metric infrastructure error, `130` cancelled by signal. The result envelope always carries the more precise error code.

Prompts state the exact pending change and default. Sensitive prompts use hidden input and convert the value to a secret reference rather than writing the value. Wizard transcripts are not part of stdout when structured output is selected.

## 6. Dry run, diff, and atomic mutation

All mutations execute this pipeline:

```text
discover → lock → read/hash → build candidate → validate all resources
→ calculate semantic diff → dry-run return OR stage → publish → verify → unlock
```

The project lock is `.attest/project.lock`. Lock metadata includes PID, process start identity, hostname, and timestamp. A caller never steals a live lock automatically. Stale-lock recovery is an explicit `attest project unlock --stale` operation with a dry run.

The semantic diff reports resource operations, references added/removed, imported row counts, dedupe decisions, redacted secret-reference changes, and validation warnings. JSON output contains `operations[]` with `op: add|update|remove|rename|attach|detach`, resource identity, old/new content hashes, and field-level JSON Pointer changes. It does not expose raw secrets or depend on text diff format.

For a write, Attest stages complete new file contents and backups in `.attest/transactions/<transaction-id>/`, fsyncs them, writes a journal, then publishes with sibling renames. The project manifest is renamed last and is the commit point for cooperating readers. If a rename fails, Attest restores every already-published path from the journal before returning. On the next command, an incomplete journal is recovered before project load. All CLI readers honor the lock and manifest hashes, so they observe either the old or new project. Direct filesystem readers can observe intermediate renames and are unsupported as a mutation/integration API.

`--if-project-hash` provides optimistic concurrency for coding agents. Imports also capture source hashes. A stale caller receives `project_changed`, the current hash, and a retryable hint; Attest never overwrites a concurrent edit.

## 7. Agent integrations

All adapters normalize to the existing `attest.agent/v1alpha1` request and response model at the runner boundary. An adapter may construct a foreign request or extract a foreign result, but the persisted invocation attempt always records the normalized request, bounded/redacted transport evidence, timing, and extraction decision.

### 7.1 Common policy

Each integration declares:

- lifecycle: `per_case`, `per_run`, or `external`;
- connect, first-byte, idle, per-attempt, and optional whole-run timeouts;
- retry count and backoff (`none`, `fixed`, or bounded exponential with deterministic jitter seed);
- request template and result/error/trace extraction using RFC 6901 JSON Pointers;
- auth references and a redaction policy;
- maximum request, response, event count, event size, and total evidence size.

Default per-attempt timeout is 60 seconds, output cap is 10 MiB, and retries are zero. Retrying is allowed only before an application result is accepted. Agent-reported errors, validation errors, authentication failures, most `4xx` responses, and metric failures are not retried. Network errors, `408`, `429` with a bounded `Retry-After`, and `5xx` may be retried when configured. Every attempt is recorded. Backoff is cancelled immediately when the run is cancelled.

Secrets are referenced as `{ "from_env": "NAME" }` or `{ "from_file": "path" }`; values are read at execution and never stored in authored files, project hashes, run bundles, diffs, logs, shell history suggestions, or structured output. `from_file` must be inside the project or explicitly allowed and is rejected when group/world readable on platforms where mode checks are available. Headers, query values, argv positions, and event fields marked sensitive are redacted before evidence persistence. v2 does not provide a keychain or cloud secret store.

### 7.2 Native request/response

Native CLI and HTTP preserve `docs/specs/agent-contract.md`:

- CLI `per_case`: fresh child, one JSON request on stdin, one JSON response on stdout, logs on stderr, process-tree termination on timeout/cancellation.
- HTTP `external`: one POST per case, response envelope in a successful response body, concurrent requests allowed.

Native is the recommended integration because it has no mapping ambiguity. `agent test` validates the full handshake, error classification, trace, and redaction behavior.

### 7.3 cURL import

`attest agent import request.curl --type curl` parses a cURL command as data; it never executes a shell or command substitution. Supported inputs are URL, method, repeated headers, literal or file-backed body, and common auth headers. Unsupported cURL flags produce a complete diagnostic list before any project write.

The importer replaces literals in request bodies with explicit placeholders selected by the user, such as `{{input.question}}`, then records JSON Pointer extraction for the result, error, optional trace, and optional remote job id. A body can remain a static literal. URLs may use input placeholders only in path/query components, with percent encoding applied by Attest.

Literal authorization headers, cookies, client certificates, shell expansions, `--config`, `--proxy`, arbitrary file upload, multipart bodies, redirects that change origin, and browser-only session auth are rejected in v2. The wizard can replace a literal bearer/basic value with an environment reference but never saves the literal.

### 7.4 CLI foreground, background, and JSONL bridge

| Mode | Lifecycle | Contract | Concurrency |
| --- | --- | --- | --- |
| `foreground` | `per_case` | one request on stdin, one response on stdout | one process per case |
| `background` | `per_run` | Attest starts a service, waits for readiness, invokes its HTTP endpoint, then stops it | endpoint-defined |
| `jsonl` | `per_run` | persistent child; one correlated request and response per JSONL line | multiplexed or serial |

Background configuration declares `start_argv`, readiness (`http`, `tcp`, or stderr regex), invoke URL, optional graceful shutdown request, and stop timeout. Readiness and shutdown share the run deadline. Attest owns the process group and always attempts TERM/grace/KILL. An agent that daemonizes, detaches, requires an interactive terminal, or needs a system service manager is unsupported; configure it as `external` HTTP instead.

The JSONL bridge uses envelopes containing `request_id` plus the native request/response. In `serial` mode Attest sends the next request only after a response. In `multiplexed` mode responses may arrive out of order and must echo unique ids. Blank lines are ignored; non-JSON stdout is a protocol error, so logs go to stderr. EOF fails all outstanding cases. On timeout, Attest cancels the whole bridge and classifies unfinished cases separately; v2 does not define an in-band per-request cancellation message.

### 7.5 Polling

Polling starts with an HTTP request that extracts `job_id` and optionally a status URL. Attest then polls a fixed same-origin URL template until a terminal state. Configuration defines status, result, error, and optional trace pointers plus terminal success/failure values.

Polling honors `Retry-After` within configured min/max intervals, otherwise uses bounded backoff. The attempt timeout spans submission through terminal extraction; connect and response caps apply to every request. Submission is retried only when configured with an idempotency header and before a job id is observed. Poll requests may retry safe transport failures. Cancellation stops polling; optional remote cancellation is deliberately unsupported in v2 because its semantics are provider-specific.

### 7.6 SSE and server-side streams

SSE uses an HTTP request whose response is `text/event-stream`. Generic newline-delimited server streams use the same event adapter but must declare `framing: jsonl`. Both define:

- optional event-name filter;
- JSON decoding location (`data` for SSE, whole line for JSONL);
- result, error, trace, and incremental-output pointers;
- terminal event/value;
- connect, idle, and total timeouts.

Comments/heartbeats reset the transport idle timeout but not the application idle timeout unless configured. Event count, line size, and aggregate size are capped. The normalized output comes only from a terminal result or an explicitly configured accumulation rule. A clean close without a terminal result is an invocation error. There is no retry after the first non-heartbeat application event unless a future adapter defines resumable event ids; v2 does not.

### 7.7 WebSockets

WebSocket mode opens one connection per eval run by default, sends correlated JSON messages, and extracts result/error/trace pointers from messages that echo `request_id`. A `per_case` connection may be selected for servers without multiplexing. Configuration includes URL, headers, subprotocol, open timeout, message idle timeout, attempt timeout, ping interval, and close timeout.

Only text JSON messages are supported. Binary frames, Socket.IO, GraphQL subscriptions, arbitrary bidirectional tool callbacks, browser cookies, interactive authentication, server-initiated work without correlation ids, and resume after disconnect are unsupported in v2. Reconnect is allowed only before any request acknowledgement; after acknowledgement, outstanding cases fail rather than risk duplicate side effects.

## 8. Test and dataset import

### 8.1 Formats and mapping

Imports accept UTF-8 CSV, JSON, and JSONL. Format is inferred from a non-stdin extension or supplied by `--format csv|json|jsonl`. CSV headers must be unique. JSON defaults to a top-level array; use `--records-pointer /path/to/array` for an envelope. JSONL accepts one object per nonblank line.

Repeated `--map <destination>=<source>` maps a source column or RFC 6901 pointer to one of:

```text
id
input or input.<field path>
expected or expected.<field path>
params.<field path>
tags
metrics
```

CSV dotted destinations build nested objects; escaping rules are documented and available in JSON help. JSON/JSONL source values use pointers prefixed with `/`; CSV uses exact header names. `--map input=/prompt` is therefore distinct from `--map input.question=prompt`. Structured CSV cells may be parsed with `--parse-json <source-column>`; otherwise they remain strings. The wizard previews five redacted rows and the normalized case shape before confirmation.

### 8.2 Validation and deterministic ids

The importer parses the complete source, applies mappings, and validates every normalized case before writing. Diagnostics include physical row/line, source field, destination path, code, and hint. The default error policy is all-or-nothing; `--allow-invalid` is not provided because silently dropping evaluation data makes CI untrustworthy.

An explicit mapped id wins after slug validation. Without one, the id is `case-<first-16-base32-chars>` of SHA-256 over canonical JSON containing dataset id plus normalized `input`, `expected`, and `params`; tags and metrics are excluded. Identical logical records in the same dataset therefore receive the same id on every machine. A cryptographic prefix collision with different content is reported and requires an explicit id; the importer never adds order-based suffixes.

### 8.3 Dedupe and incremental imports

Every imported row has a content fingerprint and optional stable source key from `--key <source>`. Within one import, duplicate ids, keys, or content fail by default. Policies are explicit:

```text
--dedupe id|key|content
--on-conflict error|skip|update
--sync append|upsert
```

- `append` adds only new rows. Existing matches follow `--on-conflict`; omitted policy is `error`.
- `upsert` requires explicit ids or `--key`. Matching rows update in place, new rows append, and absent rows remain untouched.
- `skip` preserves the existing row and reports it in the diff.
- `update` replaces normalized case fields while preserving its stable case id and original order.
- Content-derived ids cannot update changed content because the id necessarily changes; use `--key` for incremental source systems.
- Deletion by source absence is not part of import. A future `--sync replace` would need a separate destructive design and confirmation.

The dataset metadata records only source type, mapping, key field name, import timestamp, source content hash, and counts. It does not store an absolute source path or source contents unless the user explicitly requests a project-relative provenance path.

## 9. Metric authoring and import

Metric wizards use the existing contract vocabulary rather than inventing a second scoring model. For assertions, the wizard asks what evidence to inspect (`input`, `output`, `expected`, or trace), then operator and values. For trace/tool presets it shows whether the selected agent advertises trace support but allows creation before a trace exists.

Judge authoring accepts a literal rubric, `--rubric-file`, or stdin; it requires a model and stores only the provider/model identifier. Provider credentials are environment references discovered at run time. Wizard starter rubrics are versioned examples, not hidden prompts. The normalized judge request and raw response remain persisted for reproducibility.

Executable metrics use argv arrays and the native metric request/result envelope. HTTP metrics use request/result mapping equivalent to HTTP agents. cURL import has the same secret restrictions as agent cURL import. `metric test` runs against a local fixture and never creates an eval run.

The CLI must be able to author every assertion currently represented by `packages/contracts/src/metric.ts`, including `equals`, `contains`, `regex`, `json_schema`, numeric thresholds, `exists`, `tool_calls`, `spans`, and `all`/`any`/`not`. Advanced composition may use a `--from-json` command request rather than a long flag grammar, but it must not require editing the canonical resource file.

## 10. Under-five-minute happy paths

### 10.1 Human with an HTTP API

```bash
attest project init
attest agent import ./examples/request.curl --type curl --as support
attest agent test support
attest test add smoke --agent support
attest test case add smoke
attest metric add correct --preset judge-rubric
attest test metric attach smoke correct
attest eval run smoke
```

The import, case, and metric commands may prompt. Each wizard offers a working default, shows a redacted preview, and prints the next command. On the first successful run, the final output prints the run id plus copy-paste `diff`, `report`, and `view` commands.

The equivalent local-CLI/CSV path replaces `agent import` with `agent add --native-command`, then uses `test dataset import`; its wizard detects headers, proposes mappings, previews rows, and performs a dry run before confirmation.

### 10.2 Coding agent, fully non-interactive

```bash
attest project init --name support --non-interactive --output json
attest agent add support --from-json ./attest-requests/agent.json --output json
attest test add smoke --agent support --metric correct --non-interactive --output json
attest test case import smoke ./cases.jsonl --sync upsert --key external_id \
  --non-interactive --output json --if-project-hash "$PROJECT_HASH"
attest eval run smoke --output jsonl
```

The agent can discover all shapes without prose using `attest help ... --output json`, `attest schema print`, and the error catalog. Every returned resource id and project hash is data, not text that must be scraped.

## 11. Documentation architecture

Documentation is part of the CLI contract and must be usable in a context-limited coding-agent session. `docs/index.md` and `quickstart.md` lead into `concepts/{resource-model,eval-lifecycle}.md`, `cli/{index,agents,tests-and-datasets,metrics,eval-runs}.md`, `integrations/{native,curl-and-http,cli-processes,polling-and-streams,websockets}.md`, `reference/{schemas,errors,exit-codes,file-layout}.md`, executable `examples/`, and this design.

Requirements:

- `docs/index.md` answers “connect an agent,” “import tests,” “write a metric,” “run,” and “debug” in its first screen and links directly to canonical pages.
- Every guide begins with a complete copy-paste example, prerequisites, expected files, expected stdout shape, and cleanup.
- `packages/schemas/generated/` publishes project/resource, command request/result, CLI event, native envelope, metric, trace, and run-bundle JSON Schemas from the same runtime definitions.
- Every error code has a stable entry with meaning, likely causes, retryability, exit code, and at least one repair command. `attest errors --output json` exposes the same registry.
- `attest help <path> --output json` returns a versioned command tree with arguments, options, defaults, conflicts, implied flags, request schema id, examples, aliases, and deprecation data.
- Examples are executable fixtures tested against the compiled CLI. Documentation never relies on ellipses in the only copy-paste path and never embeds live credentials.
- A compact `llms.txt` points coding agents to the index, schemas, error catalog, command JSON help, and protocol specs. It summarizes; it does not fork their content.

## 12. Breaking v2 and v1 stance

v2 does not execute v1 config files and does not preserve v1's “one config contains agent, suites, cases, and metrics” data model. `suites` become tests, the single agent becomes a reusable agent resource, datasets become named project resources, metrics become named files, and `attest run` becomes `attest eval run`.

Because the repository has essentially no external users, the implementation should delete v1 authoring branches, fixtures, and docs once v2 reaches its vertical-slice gate. It must not carry a dual runtime, automatic discovery fallback, write both formats, or promise round-trip conversion.

One narrow escape hatch is allowed:

```text
attest project migrate-v1 --from <attest.config.yaml|yml|json> --into <empty-directory>
```

It is a non-destructive import tool, not compatibility. It supports only currently valid v1, creates a new v2 project in an empty target, emits a report of every mapping and unsupported field, and never edits or deletes the source. The command should be implemented only after the v2 writer exists and may be omitted from the initial preview if maintaining it delays the North Star path. No migration of `.attest/runs.db` is required unless the storage schema must change; if it does, ordinary numbered transactional store migration rules apply independently from config migration.

## 13. Explicit exclusions

This design does not include:

- a web editor or any browser-required authoring flow;
- accounts, organizations, hosted dashboards, upload/push, cloud databases, queues, or billing;
- execution of untrusted agent or metric code in a sandbox;
- automatic framework instrumentation or SDK-specific adapters;
- Windows process supervision in the initial v2 gate;
- arbitrary shell execution, browser-cookie capture, OAuth login flows, or secret persistence;
- multipart/file-upload cURL import, binary WebSockets, Socket.IO, GraphQL subscriptions, remote polling cancellation, streaming resume, or bidirectional tool callbacks;
- destructive dataset mirroring based on source absence;
- editing canonical resource files as the documented happy path.

`attest view` and `attest report` may continue as local read surfaces, but they are not expanded by this initiative and are not prerequisites for CLI authoring.

## 14. Dependency-ordered implementation decomposition

Each item is sized for one focused Codex task and names an owned seam to minimize overlapping edits. Every task must update colocated tests and public exports using the repository's single named-export statement convention. New or changed package scripts require the matching `docs/SCRIPTS.md` update.

| Order | Task and owned files | Dependencies | Acceptance gate |
| --- | --- | --- | --- |
| 1 | **v2 domain contracts** — `packages/contracts/src/project*.ts`, resource schemas, versions, generated schema registry, contract fixtures | none | Zod and generated JSON Schema agree; strict unknown-field and cross-reference fixtures pass; no runtime mutation |
| 2 | **CLI result/help/error contracts** — new CLI protocol contracts plus `packages/cli/src/help/`, `packages/cli/src/errors/` | 1 | JSON help snapshots cover every field; errors serialize identically from expected failures; stdout contains one valid document |
| 3 | **project discovery and read model** — `packages/cli/src/project/discover-project.ts`, loader/validator, hash model | 1 | parent discovery boundaries, canonical hashing, aggregate diagnostics, and v1 rejection pass on macOS/Linux paths |
| 4 | **transactional writer** — `packages/cli/src/project/transaction/` only | 1, 3 | fault-injection at every publish step proves rollback/recovery; stale hash and concurrent lock tests pass; dry run changes no bytes |
| 5 | **project/resource command shell** — `packages/cli/src/commands/project/`, `list/`, `show/`, command registration only | 2–4 | init/list/show/validate work in human and JSON modes; compiled cold smoke from empty directory passes |
| 6 | **agent resource authoring and native adapters** — `packages/cli/src/commands/agent/`, agent resource mapper; retain core native invokers | 4, 5 | add/import-native/test/rename/remove parity; secret redaction fixture; current hostile native agent suite remains green |
| 7 | **test/case/dataset resource commands** — `packages/cli/src/commands/test/`, attachment resolution | 4, 5 | exact grammar, collision aggregation, cross-reference rename/remove, and >100 direct-case warning pass |
| 8 | **tabular import engine** — `packages/core/src/import/` with CLI adapter under `commands/test/import/` | 1, 4, 7 | CSV/JSON/JSONL golden fixtures; mapping, full validation, deterministic ids, dedupe, append/upsert, and no-write-on-error tests pass |
| 9 | **metric authoring/import** — `packages/cli/src/commands/metric/`, presets in `packages/contracts/src/metric-presets.ts` | 1, 4, 5 | every current assertion is authorable; judge/exec/HTTP round-trip; preset golden files and `metric test` pass without network |
| 10 | **HTTP/cURL and polling adapters** — `packages/core/src/runner/adapters/http/`, cURL parser under `packages/cli/src/import/curl/` | 6 | cURL unsupported-flag/secret fixtures, extraction, retry/idempotency, poll timeout/cancellation, body caps, and same-origin tests pass |
| 11 | **managed CLI and streaming adapters** — `packages/core/src/runner/adapters/process/` and `/stream/` | 6 | background readiness/shutdown hostile fixtures, JSONL correlation/EOF/cancellation, SSE/JSONL caps and terminal extraction pass |
| 12 | **WebSocket adapter** — `packages/core/src/runner/adapters/websocket/` | 6, 11 | serial/multiplexed correlation, ping/idle/close, disconnect classification, and unsupported binary-frame tests pass with local fakes |
| 13 | **eval orchestration cutover** — `packages/cli/src/commands/eval/`, v2 resolver, narrow changes to `run-configuration.ts` | 3, 6–12, 9 | v2 project to persisted eval run/diff/JSONL event stream passes; no v1 discovery; cancellation and exit-code matrix pass |
| 14 | **v1 removal and optional import** — remove old config loader/templates/fixtures; isolated `commands/project/migrate-v1/` if retained | 13 | repository has one execution path; v1 files fail with migration hint; import is non-destructive and golden-tested if shipped |
| 15 | **agent-first docs and examples** — documentation tree in Section 11, `llms.txt`, executable examples | 2, 5–14 | all links/schema ids resolve; examples run against packed CLI in clean temp dirs; human and coding-agent happy paths finish under five minutes |

Parallel work is safe only after its dependency row lands. Tasks 6, 7, and 9 can proceed in parallel after the writer and command shell. Tasks 10, 11, and 12 own distinct adapter directories but should share contract fixtures established by task 6 rather than edit a common dispatcher in parallel. Task 13 alone owns the dispatcher cutover.

## 15. Open decisions requiring owner ratification

The design supplies a recommended default so implementation can be estimated, but these choices are not provable from the current source and should be ratified before the owning task starts:

1. **Canonical authored format.** Recommendation: generated JSON resources plus JSONL datasets as specified here. Alternative: SQLite-only or YAML resources. JSON best serves Git diffing, JSON Schema, and coding agents; it intentionally gives up comment-preserving manual authoring promised by v1.
2. **Namespace aliases.** Recommendation: keep only temporary `attest init` and `attest run` compatibility aliases; do not add plurals or one-letter aliases. Confirm whether even those two are worth carrying with near-zero users.
3. **Generated case-id fingerprint.** Recommendation: include dataset id, input, expected, and params; exclude tags and metric overrides. Confirm whether moving an otherwise identical row between datasets should preserve its id. If yes, remove dataset id before task 8 freezes fixtures.
4. **Background agent scope.** Recommendation: run-scoped process ownership only. Project-persistent daemons would reduce startup cost but introduce service discovery, stale ownership, and cross-run state that the current isolated runner deliberately avoids.
5. **WebSocket timing.** Recommendation: retain the contract in v2 but place implementation after polling and server streams. If design partners do not require it, task 12 can be cut without weakening the native/HTTP happy path.
6. **v1 importer timing.** Recommendation: do not block the v2 vertical slice; ship the explicit importer only if internal real configs need it. There should be no long-lived dual runtime under either choice.
7. **JSONL in-band cancellation.** Recommendation: omit it in v2 and terminate the run-scoped bridge on a case timeout. Per-request cancellation would improve multiplexed efficiency but needs a new peer protocol and conformance suite.

Until ratified, implementation tasks should use the recommendations above and keep the decision seams narrow; they must not silently choose a different behavior.
