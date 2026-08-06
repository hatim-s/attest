# attest — Foundation Decisions

> Product: a general eval runtime for AI agents. Users bring agents callable via CLI or HTTP; the runtime executes them against test cases, scores with deterministic and LLM-based metrics, and produces run diffs, reports, and interactive dashboards. Local-first, cloud later.
>
> Status: strategic foundation locked (2026-08-06). Implementation-level decisions deferred.

## 1. Company / Ambition

| Decision | Choice |
|---|---|
| Ambition | Full startup attempt |
| Resourcing | Solo founder + heavy AI-agent leverage (Claude Code etc.); review bandwidth is the bottleneck |
| Name | "attest" is a working title. Final name decided **before** the public README/launch (npm `attest` is taken; check PyPI/crates + attest.dev). Renaming after launch is off the table. |

## 2. Market

| Decision | Choice |
|---|---|
| Beachhead (first 6 months) | Startup AI product teams, 2–20 engineers, shipping agents to production without a CI quality gate |
| Later segments | Indie devs (free OSS tier, adopt as side effect) and enterprise (pulled in via pricing ladder, not targeted at launch) |
| Positioning | Wedge message: **"CI/CD for AI agents."** Category vision: agent eval platform. Lead with the CI frame in all launch messaging; the platform story is where the company grows, not what it advertises day one. |

## 3. Product Wedge (why switch from Braintrust / LangSmith / Promptfoo / DeepEval)

1. **Framework-agnostic** — the agent contract is CLI or HTTP. Any language, any framework, no SDK lock-in.
2. **Agent-native** — trajectory and tool-call assertions, multi-turn user simulation; built for agents, not prompt pairs.
3. **Best-in-class reports & dashboards** — run diffing, regression views, shareable self-contained reports. The area where OSS competitors are weakest.

Local-first is a property of the product but not the lead pitch.

## 4. Core Product Contracts

| Decision | Choice |
|---|---|
| Agent interface | CLI command or HTTP endpoint. Runtime invokes it per test case. |
| Trace contract | **Open trace schema** (JSON, aligned with OTel GenAI semantic conventions where sensible). Agents optionally emit a trace alongside the final output. No trace → output-only eval still works (progressive disclosure). Framework adapters come later as convenience wrappers that emit the same schema — the schema is the contract, adapters are sugar. |
| Test authoring | Files are the source of truth (YAML/JSON, git-versioned, CI-friendly). Local dashboard includes a UI editor that writes back to the files. |
| Metrics | Two layers: (a) **declarative assertions** in config (contains, regex, JSON-schema, tool-called, etc.) for the 80% case; (b) **executable contract** — a custom metric is any executable or HTTP endpoint receiving `{case, output, trace}` JSON and returning a score JSON. Any language; mirrors the agent contract. LLM-judge metrics built in. |
| LLM judges | BYO API keys only at launch (local and cloud). Managed inference is a later cloud upsell. |
| Dashboard | `attest view` — local web app over a local run store. `attest report` — self-contained static HTML export (CI artifact, email, PR link). |
| Eval capabilities (v1 target) | Single-turn evals; trajectory/tool-call assertions; **run diffing / regression compare** (mandatory — core of the reports wedge); multi-turn user simulation (flagship differentiator — ship at launch if ready, otherwise first fast-follow). Human review queue / judge calibration is v2. |

## 5. Open Source & Moat

| Decision | Choice |
|---|---|
| Model | Open-core |
| License | Apache 2.0 |
| OSS (free forever) | Runtime, CLI, trace schema, all metric types, local dashboard, static reports, run diffing, scheduled runs + alerting, single-player everything |
| Paid (cloud) | Hosted dashboards + team sharing (links, comments, shared run history); long-horizon CI history + cross-run analytics (trends, flakiness detection, regression timelines) |
| Paid (enterprise, later) | SSO, RBAC, audit logs, on-prem/self-hosted cloud tier — built when enterprise pull materializes, not before |
| Moat logic | License doesn't protect; accumulated run history + team workflow in cloud does. The trace schema as an open standard is a distribution asset. |

## 6. Monetization

| Decision | Choice |
|---|---|
| Structure | Seats + usage hybrid: per-seat base (collab, dashboards) + metered eval-run/storage above a free quota |
| Ladder | Free (indie/single-player cloud-lite) → Team (seats + usage) → Enterprise (custom, SSO/RBAC/on-prem) |
| Timing | Local-only OSS launch first; cloud beta ~3 months after launch, seeded by an in-product waitlist |

## 7. GTM Sequence

1. **OSS launch** — Show HN / GitHub / Product Hunt. One shot: repo must be genuinely impressive (README, demo video/GIF, quickstart that works in <5 min). Risk accepted: launching before design-partner validation; mitigate with private beta testing of the quickstart on ~5 friendly devs pre-launch.
2. **Design partners** — convert launch inbound + direct outreach to 10–20 startup teams; white-glove setup in exchange for feedback, logos, case studies. Their needs drive the cloud feature set.
3. **Framework integrations** — adapters + example repos + docs PRs for LangGraph, OpenAI Agents SDK, Vercel AI SDK, CrewAI. Ride their distribution.
4. **Content / SEO** — "how to eval agents" guides and public benchmark reports produced with the tool. Compounding background channel, starts after launch, never blocks the other three.
