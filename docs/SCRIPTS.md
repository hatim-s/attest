# Package scripts

| Name               | Package               | What it does                                                         |
| ------------------ | --------------------- | -------------------------------------------------------------------- |
| `build`            | root                  | Runs each package build task through Turborepo.                      |
| `typecheck`        | root                  | Runs workspace TypeScript checks through Turborepo.                  |
| `lint`             | root                  | Runs ESLint across the repository.                                   |
| `test`             | root                  | Runs package test tasks serially so process fixtures cannot collide. |
| `generate:schemas` | root                  | Regenerates published JSON Schemas from `@attest/contracts`.         |
| `format:check`     | root                  | Checks repository formatting with Prettier.                          |
| `format`           | root                  | Formats repository files with Prettier.                              |
| `lint:fix`         | root                  | Applies ESLint fixes across the repository.                          |
| `build`            | `@attest/contracts`   | Compiles production contract artifacts to `dist/`, excluding tests.  |
| `typecheck`        | `@attest/contracts`   | Type-checks contract source without emitting files.                  |
| `test`             | `@attest/contracts`   | Runs contract tests.                                                 |
| `test`             | `@attest/conformance` | Runs cross-package contract fixtures + fake-agent smoke tests.       |
| `typecheck`        | `@attest/conformance` | Type-checks conformance source without emitting files.               |
| `test:fuzz`        | `@attest/conformance` | Fuzzes contract parsers when `FUZZ=1` is set.                        |
| `build`            | `@attest/core`        | Builds referenced contracts and production core artifacts.           |
| `typecheck`        | `@attest/core`        | Type-checks core source without emitting files.                      |
| `test`             | `@attest/core`        | Runs core tests in one worker because process sweeps are global.     |
| `build`            | `@attest/cli`         | Compiles production CLI artifacts to `dist/`, excluding tests.       |
| `test`             | `@attest/cli`         | Runs CLI config, orchestration, report, and command tests.           |
| `typecheck`        | `@attest/cli`         | Type-checks CLI source without emitting files.                       |
| `generate`         | `@attest/schemas`     | Regenerates published schemas from the contract source.              |
| `typecheck`        | `@attest/schemas`     | Type-checks schema generation and artifact validation source.        |
| `test`             | `@attest/schemas`     | Runs the `_tests` validator for generated JSON Schema artifacts.     |
| `build`            | `@attest/web`         | Builds the self-contained dashboard HTML module for CLI embedding.   |
| `test`             | `@attest/web`         | Runs focused dashboard unit tests.                                   |
| `typecheck`        | `@attest/web`         | Type-checks web source without emitting files.                       |
