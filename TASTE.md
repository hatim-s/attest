# attest — Code Taste & Aesthetic Guide

Every orchestrating agent MUST inline the relevant parts of this guide into codex implementation prompts, and reviewers MUST enforce it. Codex writes thorough code with no taste — taste comes from here.

## Shape of the code

- **Deep modules, narrow APIs.** A package exposes a handful of well-named functions/types; internals stay internal. If a module's public surface needs a paragraph to explain, redesign it.
- **Functional core, imperative shell.** Pure logic (assertion evaluation, diff classification, hashing, envelope validation) lives in dependency-free functions. Effects (process spawn, fs, network, db) live at the edges behind small interfaces. Pure parts get property tests; edges get integration tests.
- **Composition over inheritance.** No class hierarchies. Classes only where identity + lifecycle genuinely exist (e.g., a running process handle, a db connection). Otherwise plain functions + data.
- **Data first.** Define the types/Zod schemas first; functions transform typed data. No stringly-typed plumbing. Types are inferred from Zod at boundaries — never hand-duplicate a type a schema already defines.
- **No premature abstraction.** Two call sites don't justify a helper. Three might. A "manager", "service", "util", or "helper" name is a smell — name things by what they do (`spawnAgentProcess`, `classifyRegressions`).

## Files & exports

- Named exports only. **One export statement at the bottom of the file** listing everything exported.
- `index.ts` contains re-exports ONLY — never logic.
- One concept per file; files under ~300 lines; if bigger, the concept is probably two concepts.
- Readable file names: `agent-process.ts`, `assertion-engine.ts`, `run-diff.ts` — no `utils.ts`, `helpers.ts`, `misc.ts`.
- Folder = module boundary. `internal/` subfolder allowed for private pieces.

## Documentation & comments

- Docstring (JSDoc) on every exported function, class, and non-obvious type: what it does, why it exists — not restating the signature.
- Inline comments ONLY for non-trivial logic: invariants, tricky edge cases, protocol requirements ("must kill the whole process group — child may have forked"). Never narrate the obvious.
- No TODO litter — discoveries go to PLAN.md Backlog.

## Errors

- Typed error taxonomy per package (`AttestConfigError`, `AgentInvocationError`… extending a base `AttestError` with `code`). Never throw bare strings; never swallow errors silently.
- User-facing errors are actionable: what happened, which file/case, what to do. CLI renders them without stack traces (stack behind `--verbose`).
- `Result`-style returns for expected failure paths (a failed assertion is NOT an exception); exceptions for genuinely exceptional states.

## Async & processes

- `async/await` only — no floating promises (every promise awaited or explicitly detached with a comment).
- Cancellation via `AbortSignal` threaded through, not ad-hoc flags.
- Timeouts are enforced at the edge that owns the resource; process-tree cleanup is the invoker's responsibility, always.

## Dependencies

- Boring and few. Before adding a dep, ask: does the standard library / an existing dep do this? A left-pad-class dep is an automatic reject.
- Locked stack (do not re-litigate in code): Commander, Zod, Kysely, Hono, TanStack (Router/Query/Table/AI), Tailwind + shadcn/ui, ECharts, Vitest, Playwright.

## Tests

- Colocated `*.test.ts` next to the source. Only meaningful behavior gets tested — no snapshot spam, no testing mocks.
- Deterministic: no timers without fake clocks, no network, no live LLMs. Fixtures over inline blobs when shared.
- Property tests for pure logic where inputs are combinatorial (assertions, diffing).

## Style details

- No default parameter sprawl — options objects with a defined `Options` type for >2 params.
- Early returns over nested conditionals. Max ~2 levels of nesting; extract otherwise.
- No clever one-liners; optimize for the reader. A junior should follow any file top-to-bottom.
- Naming: verbs for functions, nouns for data, no abbreviations (`configuration` → `config` is fine; `cfg`, `res`, `tmp` are not).
- Format/lint clean (ESLint + Prettier) — zero warnings policy in CI.

## Commit & PR discipline

- Conventional commits, small increments, every commit typechecks + lints + passes owned tests.
- PR stack: one PR per coherent unit (matches PLAN.md items). PR description: what, why, how to verify. Reference PLAN.md item IDs (e.g. `0A.5`).
- `package.json` script changes ⇒ update `docs/SCRIPTS.md` in the same change. Env/binding changes ⇒ `docs/ENV.md`.
