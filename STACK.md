# attest — Stack & Implementation Philosophy

> Decided 2026-08-06 after a scouted technical review (Codex gpt-5.6-sol, high reasoning; full report archived) plus founder calls on the flagged executive decisions. Implementation details stay open until build time; this locks direction.

## Executive decisions (founder calls)

| Decision | Choice | Note |
|---|---|---|
| Core language | **TypeScript** | Overrides scout's Go recommendation. Rationale: founder iteration speed, one language across runtime + dashboard, largest contributor pool among agent builders. Accepted cost: packaging is harder than Go — mitigated by Bun. |
| Runtime | **Bun** | Native `bun build --compile` single-file binaries, built-in SQLite, fast CLI startup, first-class TS. Risk accepted: younger ecosystem, occasional Node-compat gaps. |
| Distribution | **npm package + compiled binaries** | npm/npx for the JS-native majority; Bun-compiled standalone binaries via GitHub Releases, Homebrew tap, and `curl \| sh` for no-runtime installs and CI. Keeps the dependency-free wedge. ~~Open item~~ **Resolved 2026-08-06**: portable SQLite driver (`node:sqlite`, libsql fallback) so the npm package runs under both Node and Bun — see Implementation decisions below. |
| Launch platforms | **macOS + Linux; Windows as first compat fast-follow** | Beachhead is CI (Linux runners) + dev laptops. Windows process-tree/signal/quoting work deferred. |
| Trace schema | **attest envelope, OTel-mapped** | Own small versioned JSON schema (`attest.trace/v1alpha1`); reuse OTel GenAI attribute names where semantics match; ship an OTLP converter. Insulates the core contract from OTel GenAI semconv churn (still marked development) while keeping the open-standard story. |
| Cloud code location | **Separate private repo** | Unambiguous Apache boundary. Contracts/schemas published as versioned packages from the OSS repo. |

## Stack summary

- **CLI + runtime**: TypeScript on Bun. Concurrency via async pools for parallel agent invocation; explicit timeout/retry/cancellation and full process-tree kill for CLI agents.
- **LLM judges**: thin provider adapters behind one interface (Anthropic + OpenAI SDKs first). The runtime never becomes a universal provider SDK — agents and custom metrics stay language-neutral by contract.
- **Run store**: SQLite (WAL mode), one serialized writer, concurrent readers. Project-local `.attest/runs.db`. Normalized runs/cases/metric-results + searchable span metadata, with canonical raw JSON retained for inputs/outputs/traces/judge responses. Numbered transactional migrations; every persisted contract independently versioned; ULID ids, UTC timestamps, immutable completed runs. Exportable versioned run bundle (JSON/NDJSON) — the cloud ingests bundles via API, never syncs SQLite.
- **Dashboard**: React + Vite SPA embedded in the shipped artifact. `attest view` = loopback-only HTTP server (127.0.0.1, session token for writes, Origin validation). `attest report` = same components, second build entry point, run bundle inlined into one self-contained HTML file (no network requests). TanStack Table + virtualized lists; tree-shaken ECharts for distributions/trends; custom virtualized trace-waterfall component. Test at 10k cases.
- **Config**: YAML documented, JSON accepted as exact equivalent. Draft 2020-12 JSON Schema, required `config_version`, unknown-field rejection, aggregated errors with source locations, validation before any agent runs. UI editor edits via comment-preserving CST patches (never decode/re-emit whole docs); atomic rename; refuse write if file changed since load; golden round-trip tests mandatory.
- **Multi-turn simulation**: simulator loop lives in the runtime as an orchestration layer over the ordinary one-turn agent contract (`messages`, `turn_index`, `conversation_id` in the request envelope; stateless replay default, optional opaque state token for HTTP agents). Deterministic termination policy (max_turns / timeout / agent failure / simulator `finished`). Simulator prompts, params, and usage recorded separately from the tested agent.
- **Repo layout**: one public OSS monorepo — CLI, runtime, web app, schemas, docs, examples, conformance fixtures. `LICENSE`, `NOTICE`, SBOM release step, DCO sign-off (no CLA at launch), trademark policy once the name is final.

## Testing philosophy

Primary test surfaces: determinism, contract compatibility, hostile process behavior. Required CI never calls a live LLM; provider smoke tests are scheduled, budget-capped, non-blocking.

- Unit/property tests: assertions, thresholds, diff classification, hashing, retries, redaction.
- Golden conformance fixtures for every contract: config, agent, metric, trace, JUnit output, report bundle.
- Fake CLI/HTTP agents covering hangs, malformed output, huge output, partial stdout, stderr noise, non-zero exits, child processes, cancellation.
- SQLite crash/reopen + migration tests; fuzzing for parsers, trace ingestion, diffing.
- Component tests + Playwright flows for trace/diff/report views and editor round-trips.
- End-to-end binary tests from an empty temp directory; release pipeline runs install smoke tests against actual artifacts (npm + compiled binaries), with checksums, signatures, SBOM.

## Implementation philosophy

Novel **only** where the wedge is: the contracts, agent-native eval semantics, run diffing, and report UX. Boring everywhere else — buy/vendor SQLite, YAML CST parsing, JSON Schema validation, HTTP, tables, charts.

No sandboxing of user executables in v1: agents and custom metrics are trusted project code. Controls instead: temp working directory, env-var allowlist, output caps, deadlines, full process-tree kill. Cloud never executes uploaded metrics in the control plane; future remote execution goes to isolated disposable workers.

## De-risking prototypes (before broad build-out — feeds Roadmap Phase 0/1)

1. Vertical slice: config → concurrent CLI+HTTP agent execution → SQLite → diff → single-file HTML report.
2. Cross-platform (macOS/Linux) timeout + process-tree termination under Bun.
3. Lossless YAML editing under comments, multiline strings, concurrent modification.
4. One large traced run rendered from both localhost and self-contained HTML.
5. OTel→attest trace conversion using real traces from two agent frameworks.
6. Bun-specific: `bun build --compile` artifact size/startup check + npm-under-Node vs requires-Bun decision spike.

Biggest technical risks (scout + founder agreement): contract churn, unreproducible judge behavior, safe process supervision, YAML round-tripping, report performance at large trace volume — plus Bun ecosystem maturity, added by the TS decision. De-risk these first; more providers, framework adapters, advanced charts, plugins, and multi-turn polish wait.

## Implementation decisions (locked 2026-08-06)

### Runtime & core

| Area | Choice | Rationale / notes |
|---|---|---|
| SQLite driver | **Portable: `node:sqlite` (Node 22+), libsql fallback** | npm package runs under both Node and Bun — npx quickstart works for everyone. Skips `bun:sqlite` speed; acceptable. |
| Monorepo tooling | **Bun workspaces + Turborepo** | Bun installs/links; turbo task graph + caching across cli/web/schemas/docs packages. |
| Lint/format | **ESLint + Prettier** | Founder call over Biome: max rules ecosystem (react-hooks, import cycles), standard for OSS contributors. |
| CLI framework | **Commander** | Boring and universal — novelty budget stays in the contracts. |
| Validation | **Zod as source of truth → generated JSON Schema** | TS types inferred free; JSON Schema emitted (Zod v4 native) and checked into `schemas/`. Conversion edge cases covered by golden tests. |
| DB access | **Kysely** | Type-safe SQL over any driver dialect; migrations stay hand-written numbered SQL per the store decision. |
| Local server | **Hono** | Identical on Node + Bun (matches portable-driver decision); tiny, typed; ports to Workers for cloud. |
| LLM judge layer | **TanStack AI SDK** behind own thin judge interface | ⚠️ Risk accepted: very new SDK. Contained — the judge interface is ours; SDK swappable (Vercel AI SDK as fallback) without touching metric contracts. |

### Frontend

| Area | Choice | Notes |
|---|---|---|
| Data/routing | **TanStack Router + Query** | Type-safe routes, polling/cache for live runs; consistent with TanStack Table + AI SDK. |
| Styling | **Tailwind + shadcn/ui** | Owned components, fast build-out, clean CSS inlining for static reports. |
| Charts | **Tree-shaken Apache ECharts** | Canvas perf for 10k-case distributions; works in self-contained report HTML. |

### Quality & delivery

| Area | Choice | Notes |
|---|---|---|
| Testing | **Vitest + Playwright** | Vitest for unit/property/component (Node path is the required matrix); Playwright for dashboard flows + editor round-trips. No live LLMs in required CI (already locked). |
| Releases | **Changesets + GitHub Actions matrix** | PR-based changelogs; release workflow: npm publish + bun-compiled binaries (darwin/linux × arm64/x64) + checksums + Homebrew tap bump. |
| Docs site | **Astro Starlight** | Purpose-built docs; Phase 0 contract specs land here as launch content. |
| Telemetry | **Opt-out anonymous, loud disclosure** | Command counts, version, OS only — never payloads/prompts/keys. First-run notice, `ATTEST_TELEMETRY=0`, config flag, documented schema. |

### Cloud (directional — built month 5–7)

| Area | Choice | Notes |
|---|---|---|
| Compute | **Cloudflare Workers** | Hono ports as-is. Heavy run-bundle ingest goes through Workers Queues, not request handlers. |
| Database | **Cloudflare D1** | Founder call (Neon excluded). SQLite semantics ≈ local schema/migrations reuse — strong symmetry. Constraints accepted: 10GB/db → per-org database sharding pattern from day one; cross-org analytics via scheduled rollups into aggregate tables (D1 is not an analytics engine). Revisit only if cross-run analytics outgrow it. |
| Object storage | **Cloudflare R2** | Large immutable payloads (traces, outputs, report bundles); zero egress cost for shared reports. |
| Auth | Open — decide at cloud build time (D1 choice removes Supabase bundled-auth shortcut; candidates: Better Auth on Workers, Clerk, CF Access for early beta). |
