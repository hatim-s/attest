# attest — Session Handoff

**Written:** 2026-08-07, at the point work was aborted mid-Phase-1.
**Read order for a fresh session:** this file → `PLAN.md` (restore it, see below) → `TASTE.md` → `docs/specs/`.

---

## 1. Where things stand in one paragraph

Phase 0 (contracts + scaffold) and four of five Phase 1 tracks are **merged to main and reviewed**. The fifth track (runner) is **code-complete on two open PRs (#9, #12) but not merged**, blocked solely on an unresolved CI mystery — the test suite passes locally in 30 seconds but GitHub jobs are being marked `cancelled` at ~15 minutes with no failing step. Nothing is broken on main. The next session's first job is to resolve that CI question, merge the runner, then build the Phase 1 gate (the vertical slice that ties the merged pieces into a working `attest run`).

---

## 2. Strategy and design decisions — all settled, do not re-litigate

Four documents on main hold every decision made before implementation started. They were produced by structured interrogation and a scouted technical review; treat them as binding unless you deliberately revisit one.

| File | Holds |
|---|---|
| `DECISIONS.md` | Market, beachhead (startup teams 2–20 eng), positioning ("CI/CD for AI agents"), the three-part wedge, open-core boundary, Apache 2.0, seats+usage pricing, GTM sequence |
| `STACK.md` | TypeScript on Bun, npm + compiled binaries, SQLite/Kysely, Hono, React/Vite/TanStack/Tailwind+shadcn/ECharts, Vitest+Playwright, Changesets, Astro Starlight, opt-out telemetry, and the cloud direction (Cloudflare Workers + D1 + R2) |
| `ROADMAP.md` | Phase structure and cut lines |
| `TASTE.md` | The binding code-aesthetic contract. **Every implementation prompt must paste the relevant sections**; codex has no taste of its own and will produce thorough, ugly code without it |

Published foundation doc (strategy + stack + roadmap, for sharing): https://hatim-s.github.io/planloft-plans/p/nKsD1IWDXi/

---

## 3. What is merged on main

Nine PRs, each through the same pipeline: track-internal adversarial codex review → independent codex review (`gpt-5.6-sol`, high reasoning) → Opus taste review → fix round(s) → CI. Roughly 70 post-implementation findings were caught and fixed this way; 2 were rejected with recorded rationale.

| PR | What landed |
|---|---|
| #1 | Monorepo scaffold: Bun workspaces + Turborepo, `packages/{cli,contracts,core,schemas,web}`, ESLint+Prettier, CI, Apache-2.0/NOTICE/DCO |
| #4 | The four contract specs (`docs/specs/`) + `docs/TELEMETRY.md` |
| #3 | `@attest/contracts`: Zod schemas as source of truth, generated JSON Schemas in `@attest/schemas`, dual-validator (zod+ajv) conformance tests |
| #7 | `AttestError` base class — the shared error taxonomy root |
| #5 | Run store: portable driver (`node:sqlite` primary, libsql fallback), Kysely, schema v1 with integrity triggers, migrations, paginated queries |
| #6 | Diff engine (verdict transitions with flakiness as an *orthogonal annotation*), CI thresholds → `CiVerdict`, JUnit export, NDJSON run bundles, response cache |
| #8 | `@attest/conformance`: 32 contract fixtures, 11-behavior hostile fake agents (CLI + HTTP), weekly non-blocking fuzz lane |
| #10, #11 | Metrics: pure assertion engine, exec-contract metrics, LLM judges (TanStack AI, BYO keys, full reproducibility evidence), dispatcher with per-metric isolation, store mapping, runner→metrics adapter |

Current test counts on main: 293 core + 57 contracts + 48 conformance.

**Design decisions made during implementation** (recorded here because they are not obvious from the code):
- Runner's `lower_snake` error codes are canonical repo-wide (they are persisted by the store). Store/diff still use `SCREAMING_SNAKE` — rename is in the backlog.
- Regex assertions stay synchronous with a 64 KiB pre-execution input cap. No worker preemption in v1 — agents and metrics are the user's own trusted project code. A completed match must never report `passed: false` for timing reasons.
- Process containment is explicitly **best-effort**, documented with enumerated gaps. Real containment (cgroup v2) is backlogged.
- The agent's environment is synthesized per attempt (`HOME`/`TMPDIR` under the attempt directory, filtered absolute `PATH`, `LC_ALL=C`); inheriting real host values requires explicit opt-in. This closed a credential-exposure path.
- `attest.trace/v1alpha1` is our own envelope with OTel GenAI attribute *names* reused where semantics match — deliberately not a dependency on the unstable semconv.

---

## 4. The one open blocker: runner PRs #9 and #12

**Branches:** `phase1/runner` (#9, invokers) → `phase1/runner-pool` (#12, pool/datasets/executeCases, stacked). Worktree: `/Users/admin/Projects/attest-wt/p1-runner`, HEAD `ee9ace8`, pushed.

**The code is done.** It covers CLI and HTTP invokers, process-group spawn with descendant-snapshot termination and PID-identity validation before any post-grace kill, per-attempt working directories, manual redirect handling, bounded attempt evidence, a bounded concurrency pool with leak-proof teardown, JSONL datasets, and `executeCases`. It survived two adversarial review rounds plus one from me.

**Verified locally by me at `ee9ace8`, with the CI environment variables applied:** 293/293 core, 57/57 contracts, 48 conformance — all green, whole suite 30 seconds.

**The blocker:** GitHub jobs get `conclusion: cancelled` at ~15 minutes with no failing step and no retrievable logs. It is not OS-specific — it has hit macOS once and ubuntu twice, while the *other* OS in the same run passed in under a minute. Two candidate explanations, unresolved:

1. **`concurrency: cancel-in-progress: true` in `.github/workflows/ci.yml`.** Rapid successive pushes (rebases, fixups) cancel in-flight runs. This cleanly explains why fast jobs pass and slow ones die, and why logs are missing. **Test it by pushing once and leaving the branch untouched until the run completes.** Do this first — it is free.
2. **A genuine hang or resource exhaustion on the slow job.** Earlier, three process-tree kill tests failed under throttled workers with a fixture-readiness timeout (~8s deadline where 30s was the standard elsewhere), and a failed readiness meant the test never learned the orphan's PID, so teardown leaked a heartbeating process. Commit `2bd9dbb` fixed the deadlines and made teardown leak-proof, and my local run confirms it is fixed *locally*.

**Also unresolved:** whether `VITEST_MAX_THREADS/FORKS=2` in CI helps or hurts. My measurement at `e2311dc` showed throttling *causing* three failures; the agent's last measurement at `ee9ace8` claimed the opposite (default parallelism failing, throttled clean). Both were taken at different commits, so neither refutes the other. Re-measure at the current HEAD before trusting either.

**My recommendation:** keep macOS a required check through the alpha — process-tree termination is the one genuinely OS-divergent area and these tests are what cover it. If queue starvation persists after the concurrency question is settled, move macOS to a nightly lane rather than let it block merges.

---

## 5. Immediate next steps

1. **Settle the CI question** (§4). Push once, wait, read the result. If it was `cancel-in-progress`, consider scoping the concurrency group so it does not cancel runs you care about.
2. **Merge the runner stack bottom-up**: #9 then #12. Both contain deliberate cross-package edits (store `types.ts` + `from-runner.ts`, metrics adapter seam typing) — bottom-up merge produces the coherent tree.
3. **Phase 1 gate** — this is the first moment the product exists end to end. Wire the merged pieces into the vertical slice: config → parallel agent invocation → metrics → store → diff → JSON/JUnit out, exposed as `attest run` in `packages/cli` (currently a stub). The pieces were built to fit: `executeCases` emits `CaseExecution`, `caseExecutionToMetricContext` adapts it for metrics, `toStoredCaseExecution` adapts it for the store, `diffRuns` reads the store back.
4. **Then Phase 2** (dashboard, static report, trajectory assertions) and **v0 alpha assembly** (`attest init`, example agents, quickstart, tag).

---

## 6. How the work was run, and what to change

**The pattern that worked:** I orchestrate; a Fable subagent owns each track and holds the taste standard; that subagent delegates implementation to codex shells with *exact file structures, exact signatures, and TASTE.md pasted verbatim*; every stack then gets an independent codex correctness review and an Opus taste review from me before merge. The reviews consistently found real defects — a PID-reuse race that could signal an unrelated process, `HOME` inheritance exposing credentials to agents, `fetch` following redirects and forwarding case payloads to third parties, retries sharing a working directory, a flakiness heuristic that could mask genuine regressions from CI. None of these would have survived to production, and none were caught by the implementing agent alone.

**The pattern that failed:** track orchestrators repeatedly ended their turn while their codex shell was still running, expecting a wake-up that never came. This happened at least five times and cost hours of wall-clock, not compute. Mitigations tried (file-activity watchdogs) produced false positives and did not address the cause.

**Do this differently next session:** have each track agent launch its codex shell and immediately hand control back to the coordinator, so the *coordinator* holds the polling loop. More chatter through the top, but no silent hours.

**And verify claims independently.** One track reported "293/293 green" on a suite that demonstrably failed three tests under the CI settings it had itself added. I found it in about a minute by running the suite myself. Cheap check, do it before every merge.

---

## 7. Environment notes and gotchas

- **No `timeout` binary on this Mac.** Use `perl -e 'alarm N; exec @ARGV' -- <cmd>`.
- **`codex exec` hangs without `< /dev/null`** ("Reading additional input from stdin").
- **Never pipe codex through `tail`/`grep`** — pipes buffer until exit and the run looks stuck. Redirect to `.logs/<step>.log` and inspect the file.
- **Run `bun run format` after codex edits** before `format:check`.
- **`rtk` shell wrapper** swallows output from some commands (`ls`, `cat`). Use `/bin/ls`, `/bin/cat` when output looks suspiciously empty.
- **PLAN.md is gitignored by design.** Canonical copy: `~/.planloft/docs/attest/attest-implementation-plan.md`. Restore with `planloft copy attest-implementation-plan` (or `node /Users/admin/Projects/planloft/dist/cli.js copy attest-implementation-plan`) and place at repo root. After any status change, rehost and redeploy — commands are in `CLAUDE.md`. Live plan: https://hatim-s.github.io/planloft-plans/p/nKsD1IWDXi/
- **`planloft` is not on PATH** — invoke via `node /Users/admin/Projects/planloft/dist/cli.js`.
- **`NODE_TLS_REJECT_UNAUTHORIZED=0` is set in this environment.** It disables TLS certificate verification for all Node processes. Worth unsetting when not debugging.

**Worktrees still on disk** (all merged except the runner; safe to remove with `git worktree remove` once you no longer want the logs):

```
/Users/admin/Projects/attest-wt/p1-runner      phase1/runner-pool   ← ACTIVE, holds the open work + .logs/ review reports
/Users/admin/Projects/attest-wt/p1-metrics     phase1/metrics-exec-judges (merged)
/Users/admin/Projects/attest-wt/p1m-base       phase1/metrics (merged)
/Users/admin/Projects/attest-wt/p1-store       phase1/store (merged)
/Users/admin/Projects/attest-wt/p1-diff-fix    phase1/diff (merged)
/Users/admin/Projects/attest-wt/p1-testinfra   phase1/test-infra (merged)
/Users/admin/Projects/attest-wt/phase0         phase0/contracts-package (merged)
```

Every track's review reports are preserved in its worktree's `.logs/` — `independent-review-*.md` and `opus-taste-review-*.md` are the substantive ones and are worth reading before touching that track's code.

---

## 8. Decisions still owed by the human

- **Product name.** "attest" is a working title; npm `attest` is taken. This blocks the public README and docs-site branding, not development. It must be settled before anything is published.
- **Schema v1 DDL freeze.** Reviewed and hardened (discriminated outcomes, semantic CHECKs, immutability triggers), currently pre-1.0 and edited in place. Worth a look before the first release makes migrations real: `packages/core/src/store/migrations/0001_schema_v1.sql`.
- **macOS as a required CI check** (see §4) — my recommendation is to keep it through the alpha.
