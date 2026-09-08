# Contributing

## Set up the workspace

Use Node.js 22.15 or newer and Bun 1.4. From the repository root:

```bash
bun install --frozen-lockfile
bun run build
node packages/cli/dist/cli.js --help
```

Build before running the CLI or package tests. Workspace imports resolve to compiled
`dist/` exports, so rebuild after editing a dependency package. The build also embeds
the dashboard in the CLI; a TypeScript-only build of `packages/cli` does not rebuild
that dashboard.

Follow the [quickstart](docs/quickstart.md) with the shell function in the
[README](README.md#try-it-from-source) to exercise the compiled CLI outside the checkout.

## Find the owning package

| Package              | Owns                                                                              |
| -------------------- | --------------------------------------------------------------------------------- |
| `packages/contracts` | Resource schemas, transport protocols, result types, and parsers.                 |
| `packages/core`      | Agent invocation, metrics, evaluation execution, SQLite storage, and view server. |
| `packages/cli`       | Commands, authored project transactions, machine output, and acceptance journeys. |
| `packages/web`       | Embedded dashboard and report UI.                                                 |
| `packages/schemas`   | Generated JSON Schema artifacts.                                                  |
| `conformance`        | Fixtures that verify contracts across package boundaries.                         |

Keep authored examples under `examples/`. Put focused tests and fixtures together in
the owning module's existing `_tests/` directory. Read [AGENTS.md](AGENTS.md) for repository
instructions and [docs/TESTING.md](docs/TESTING.md) for the testing policy.

## Verify a change

During development, run the owning package's tests, for example:

```bash
bun run --cwd packages/contracts test
```

Before submitting, run the repository checks:

```bash
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run build
```

If you change contract schemas, run `bun run generate:schemas` and include the generated
artifacts. Document script changes in [docs/SCRIPTS.md](docs/SCRIPTS.md). Keep examples
and structured help consistent with CLI changes. Required tests use local fixtures and
do not need provider credentials. CI checks Linux and macOS.

For package contents and installation checks, use the
[release guide](docs/RELEASING.md). A passing workspace build alone does not verify
that the published packages install outside the repository.

## Submit changes

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages, such as
`feat(core): add a run reader` or `fix(cli): report malformed input`.

All contributions require a Developer Certificate of Origin (DCO) sign-off. Add one with
`git commit -s`; this certifies that you have the right to submit the contribution under the
project license.
