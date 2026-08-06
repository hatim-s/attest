# attest — Roadmap to Launch

Assumes solo founder + heavy AI-agent leverage, full-time-equivalent throughput, review bandwidth as the limiting factor. Weeks are targets, not promises. Cut line is explicit per phase.

## Phase 0 — Contracts & Name (week 1–2)

The contracts are the product; everything else is replaceable.

- [ ] Spec the **agent contract**: CLI invocation shape (stdin/stdout JSON? args? env?) and HTTP equivalent; timeout, retry, concurrency semantics.
- [ ] Spec the **trace schema** v0: spans for LLM calls, tool calls, agent steps; alignment pass against OTel GenAI semantic conventions.
- [ ] Spec the **config format**: suites, cases, datasets, metrics, judges, run settings.
- [ ] Spec the **metric contract**: declarative assertion set v0 + executable/HTTP metric interface (`{case, output, trace}` → score JSON).
- [ ] Name decision: candidates, npm/PyPI/crates/domain checks, pick final. (Blocks public README, not development.)
- [ ] Write the specs as public-ready docs — they double as launch content ("an open trace standard for agent evals").

## Phase 1 — Core Runtime (week 2–6)

- [ ] Runner: load config → invoke agent (CLI + HTTP) per case → collect outputs/traces; parallelism, timeouts, retries, caching.
- [ ] Deterministic metrics: declarative assertions engine.
- [ ] Executable-contract custom metrics.
- [ ] LLM-judge metrics (BYO keys; Anthropic + OpenAI first), with judge prompt templates for common rubrics.
- [ ] Local run store (embedded DB) + run metadata (git SHA, config hash, timestamps).
- [ ] **Run diffing**: compare two runs, per-case verdict changes, metric deltas, regression list. CLI output first.
- [ ] CI mode: exit codes, thresholds, machine-readable output (JSON/JUnit).

Cut line: nothing here is cuttable — this is the minimum credible product.

## Phase 2 — Dashboard & Agent-Native Evals (week 6–10)

- [ ] `attest view`: local web app — run list, case drill-down, trace viewer, diff view between runs.
- [ ] `attest report`: self-contained static HTML export of a run or a diff.
- [ ] UI test-case editor that writes back to config files.
- [ ] Trajectory/tool-call assertions over the trace schema (tool called, order, args match).

Cut line: UI editor slips to fast-follow if the timeline is tight; trace viewer and diff view do not slip.

## Phase 3 — Simulation, Polish, Launch (week 10–14)

- [ ] Multi-turn user simulation: LLM-played user personas, conversation-level metrics. **If not solid by week 12, ship it as the v0.2 headline instead — do not delay launch.**
- [ ] Quickstart that works in <5 minutes; test it cold on ~5 friendly devs, fix everything they trip on.
- [ ] README, demo video/GIF, example agents (one CLI, one HTTP, one traced).
- [ ] Docs site: contracts, guides, metric reference.
- [ ] Cloud waitlist link in CLI output + README.
- [ ] **Launch**: Show HN + Product Hunt + X/LinkedIn. Everything staged in advance; pick a Tuesday–Thursday.

## Post-Launch — Partners & Distribution (month 3.5–5)

- [ ] Convert inbound + outreach → 10–20 design partners (startup teams, 2–20 eng). White-glove onboarding; weekly feedback loop.
- [ ] Adapters: LangGraph, OpenAI Agents SDK, Vercel AI SDK, CrewAI — each with an example repo; upstream docs PRs where accepted.
- [ ] First content pieces: agent-eval guide + one public benchmark report built with the tool.
- [ ] Human review queue / judge calibration if partners pull for it.

## Cloud Beta (month 5–7)

- [ ] Hosted dashboards + shared run links/comments; `attest push` from CLI/CI.
- [ ] Team run history + cross-run analytics (trends, flakiness, regression timelines).
- [ ] Auth, orgs, seats + usage metering; free/team pricing live.
- [ ] Seed with design partners before public availability.

## Deferred (pull-based, not scheduled)

- Enterprise: SSO, RBAC, audit, self-hosted control plane.
- Managed judge inference (cloud upsell).
- UI-first authoring for non-engineers; PM/QA personas.
- Public trace-schema governance (only if adoption warrants).
