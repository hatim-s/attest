# Technical recommendation

Build attest as a self-contained Go application with an embedded React/Vite dashboard, SQLite storage, YAML/JSON configuration, and a small versioned trace envelope that maps cleanly to OTel GenAI conventions. This architecture best supports the actual wedge: a reliable CI tool that installs instantly, invokes agents in any language, and produces unusually good local reports.

## 1. Core runtime language

**Recommendation: Go.** The external CLI/HTTP contracts remove most need for in-process LLM libraries, while Go provides native binaries, excellent process and HTTP primitives, cheap concurrency, fast builds, and code that a solo founder can review after AI generation.

| Language | Assessment |
|---|---|
| **Go** | Best balance: native distribution, goroutines, strong standard library, explicit code, manageable contributor learning curve. |
| TypeScript/Node | Fastest initial UI-adjacent iteration and broad LLM SDK support, but requires Node or brittle executable bundling; native SQLite packaging is already a visible failure mode in competing Node tools. |
| Rust | Best control and safety, but ownership complexity, compilation time, and lower contributor accessibility consume scarce review capacity without improving the product wedge. |
| Python | Strongest AI ecosystem and familiar to ML contributors, but weak native distribution, environment conflicts, multiprocessing complexity, and dynamic contract failures are poor fits for CI infrastructure. |

Use minimal provider adapters behind a Go interface, preferably official OpenAI and Anthropic SDKs where they remain thin. Do not turn the runtime into a universal provider SDK; the agent and custom-metric contracts are deliberately language-neutral.

**EXEC DECISION: Which engineering ecosystem should the company commit to? — A: Go gives durable distribution, operational simplicity, and reviewable concurrency, but fewer AI-native contributors; B: TypeScript maximizes founder iteration and JS contributions, but accepts a Node/runtime dependency and packaging complexity. Choose A.**

## 2. Distribution

**Recommendation: make versioned native binaries the sole canonical artifact.** Publish checksummed macOS and Linux binaries through GitHub Releases, a Homebrew tap, and a short installer; add Scoop/WinGet when Windows is supported, but do not maintain npm and pip implementations or wrappers at launch.

Promptfoo currently supports npm/npx and Homebrew but requires Node; DeepEval is installed through pip; Braintrust’s newer `bt` CLI uses a downloaded prebuilt binary. That validates both the incumbent language ecosystems and the opportunity for attest’s dependency-free installation. [Promptfoo installation](https://www.promptfoo.dev/docs/installation/), [DeepEval CLI](https://deepeval.com/docs/command-line-interface), [Braintrust CLI](https://www.braintrust.dev/docs/reference/cli/quickstart)

Also provide:

- `attest version --json`, shell completions, checksums, signatures, and an SBOM.
- A pinned GitHub Action that downloads the same binary—no second implementation.
- Docker only for hermetic CI, not as the normal local experience.
- `go install` as a developer convenience, not the documented quickstart.

**EXEC DECISION: Which operating systems are launch-blocking? — A: macOS and Linux first minimizes process-supervision and filesystem edge cases; B: include Windows for broader OSS adoption but add substantial quoting, job-object, signal, file-locking, and release testing work. Choose A and ship Windows as the first compatibility fast-follow.**

## 3. Local run store

**Recommendation: SQLite in WAL mode, with one serialized writer and concurrent readers.** It gives atomic runs, indexing, portable backups, and dashboard queries without the analytical-engine footprint of DuckDB or the corruption/query problems of flat files.

Use a project-local ignored database such as `.attest/runs.db`; keep cache and global settings elsewhere. The model should normalize runs, cases, metric results, and searchable span metadata, while retaining canonical raw JSON for inputs, outputs, traces, and judge responses.

Schema evolution:

- Embed numbered, transactional forward migrations and track a database schema version.
- Back up before destructive migrations; support opening older schemas read-only if migration fails.
- Give every persisted contract its own version. Never infer format from application version.
- Use stable UUID/ULID identifiers, UTC timestamps, content hashes, and immutable completed runs.
- Export a documented, versioned run bundle as JSON/NDJSON; add Parquet only when real analytical demand appears.

Cloud must ingest run bundles through an API, not copy or synchronize SQLite. Use PostgreSQL for team/run metadata and object storage for large immutable trace/output payloads; local and cloud stores should implement the same domain repository interfaces without sharing their physical schema.

## 4. Dashboard

**Recommendation: a React/TypeScript Vite SPA compiled into the Go binary with `embed.FS`; `attest view` starts a loopback-only Go HTTP server rather than a separate frontend process.** This preserves modern UI productivity while retaining one process and one installable artifact.

Create two build entry points over the same components:

- Interactive mode loads through a versioned localhost JSON API.
- Report mode receives a compact run bundle inlined into one HTML file, with JS, CSS, fonts, and icons embedded and no network requests.

Use TanStack Table plus virtualized lists for case and span volume. Use tree-shaken Apache ECharts only for distributions and future trends; implement the trace waterfall as a dedicated virtualized component. Test reports at 10,000 cases and impose explicit size warnings or optional payload truncation.

Bind only to `127.0.0.1`, require an unguessable session token for writes, validate `Origin`, and constrain editor paths to the discovered project root.

## 5. Config format

**Recommendation: YAML as the documented authoring format, JSON as an exactly equivalent accepted format; reject TOML and typed DSLs in v1.** YAML fits nested suites and multiline prompts, while JSON preserves machine generation and gives JSON Schema a natural canonical model without forcing users to install Pkl or CUE.

Publish a Draft 2020-12 JSON Schema and require a top-level `config_version`. Validation should reject unknown fields, aggregate errors with source locations, and run before any agent process starts.

For UI editing, use a comment-aware concrete-syntax tree and patch only the selected nodes; never decode and re-emit the whole document. Preserve comments, ordering, quote style, and untouched byte ranges, reject writable YAML anchors/merge keys, use atomic rename, and refuse the write if the file changed since it was loaded. Golden round-trip tests are mandatory.

## 6. Trace schema

**Recommendation: define a small attest JSON envelope inspired by OTel, not raw OTLP and not a wholesale copy of the current GenAI semantic conventions.** OTel’s GenAI attributes have moved to a separate repository and are still marked development, so direct dependence would transfer upstream churn into attest’s core product contract. [OTel GenAI registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/), [OTel semantic conventions](https://opentelemetry.io/docs/specs/semconv/)

The envelope should contain `trace_id`, spans with `span_id`/`parent_span_id`, start/end timestamps, status, kind, attributes, events, and optional structured input/output. Reuse OTel names such as `gen_ai.operation.name` and `gen_ai.tool.call.arguments` where semantics match; define `attest.*` attributes for evaluation-specific concepts.

Version it as `attest.trace/v1alpha1`, publish JSON Schema plus fixtures, and record the OTel semconv version used for mapping. Readers must preserve unknown fields, up-convert older versions into one internal representation, and never rewrite original submitted traces.

## 7. Multi-turn simulation

**Recommendation: put the simulator loop in the runtime as an orchestration layer, not inside the agent adapter or metric system.** The simulator generates the next user message; the ordinary agent contract executes one turn; transcript-level metrics evaluate the completed conversation.

Extend the request envelope with `messages`, `turn_index`, and a stable `conversation_id`. Default to stateless replay of the transcript; allow an optional opaque state token for HTTP agents, but persist enough data to diagnose and replay every turn.

Termination is a deterministic policy combining `max_turns`, timeout, agent failure, and a structured simulator `finished` result. Record simulator prompts, model parameters, token usage, and traces separately from the tested agent so a judge cannot accidentally score its own hidden reasoning.

## 8. Repository and licensing

**Recommendation: one public OSS monorepo for the CLI, Go runtime, web application, schemas, documentation, examples, and conformance fixtures; keep cloud code in a separate private repository.** The local product needs atomic contract/UI/runtime changes, while a repository-level Apache boundary is much harder to misunderstand than selectively licensed directories.

Suggested layout:

```text
cmd/attest/
internal/{runner,process,metrics,store,server,report}/
pkg/contracts/
schemas/
web/
conformance/
examples/
docs/
```

The public root should contain `LICENSE`, `NOTICE`, dependency attribution, an SPDX/SBOM release step, and clear generated-code notices. Use DCO sign-off initially rather than adding CLA friction; publish a separate trademark policy once the name is final.

**EXEC DECISION: Where does proprietary cloud code live? — A: separate private repository gives an unambiguous license and security boundary but requires versioned contracts across repos; B: a private product monorepo with OSS subtree synchronization simplifies atomic cloud changes but adds release machinery and accidental-disclosure risk. Choose A.**

## 9. Runtime testing and CI

**Recommendation: treat determinism, contract compatibility, and hostile process behavior as the primary test surfaces.** Required CI must never call a live LLM; provider smoke tests should be scheduled, budget-capped, and non-blocking.

The test pyramid should include:

- Pure unit/property tests for assertions, thresholds, diff classification, hashing, retries, and redaction.
- Golden conformance fixtures for config, agent, metric, trace, JUnit, and report contracts.
- Fake CLI and HTTP agents covering hangs, malformed output, huge output, partial stdout, stderr, non-zero exit, child processes, retries, and cancellation.
- SQLite crash/reopen and migration tests.
- Fuzzing for parsers, trace ingestion, and diffing.
- React component tests plus Playwright flows for trace/diff/report views and editor round-trips.
- End-to-end binary tests from an empty temporary directory.

GitHub Actions should run formatting, lint, typecheck, Go tests, race detection on Linux, frontend tests, integration tests, and the release build matrix. Releases require reproducible-ish build metadata, signatures, checksums, SBOMs, and install smoke tests against the produced artifacts.

## 10. Implementation philosophy and de-risking

**Recommendation: be novel only in contracts, agent-native evaluation semantics, run diffing, and report UX; use boring components everywhere else.** Build the runner, assertion engine, trace normalization, diff model, and report experience; buy libraries for SQLite, YAML parsing, JSON Schema, HTTP, tables, and charts.

Do not sandbox arbitrary executables in v1: declare agents and custom metrics trusted project code, run them in a temporary working directory, forward environment variables through an explicit allowlist, cap output, enforce deadlines, and kill the entire process tree. Cloud must never execute uploaded metrics in the control plane; any future remote execution belongs in isolated, disposable workers.

Prototype these before broad implementation:

1. A vertical slice: config → concurrent CLI/HTTP execution → SQLite → diff → single-file report.
2. Cross-platform timeout and process-tree termination.
3. Lossless YAML edits under comments, multiline strings, and concurrent file modification.
4. A large traced run rendered from both localhost and self-contained HTML.
5. OTel-to-attest trace conversion using real traces from two agent frameworks.

The largest risks are contract churn, unreproducible judge behavior, safe process supervision, YAML round-tripping, and reports collapsing under large traces. De-risk those directly; additional providers, framework adapters, advanced charts, DuckDB, plugins, and multi-turn polish can wait.