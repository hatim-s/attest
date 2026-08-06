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
| `build`            | `@attest/contracts`   | Compiles contract artifacts to `dist/`.                              |
| `typecheck`        | `@attest/contracts`   | Type-checks contract source without emitting files.                  |
| `test`             | `@attest/contracts`   | Runs contract tests.                                                 |
| `test`             | `@attest/conformance` | Runs cross-package contract fixtures + fake-agent smoke tests.       |
| `typecheck`        | `@attest/conformance` | Type-checks conformance source without emitting files.               |
| `test:fuzz`        | `@attest/conformance` | Fuzzes contract parsers when `FUZZ=1` is set.                        |
| `build`            | `@attest/core`        | Compiles core artifacts to `dist/`.                                  |
| `typecheck`        | `@attest/core`        | Type-checks core source without emitting files.                      |
| `test`             | `@attest/core`        | Runs core tests in one worker because process sweeps are global.     |
| `build`            | `@attest/cli`         | Compiles CLI artifacts to `dist/`.                                   |
| `test`             | `@attest/cli`         | Runs CLI config, orchestration, report, and command tests.           |
| `typecheck`        | `@attest/cli`         | Type-checks CLI source without emitting files.                       |
| `test`             | `@attest/schemas`     | Validates generated JSON Schema artifacts.                           |
| `build`            | `@attest/web`         | Builds the self-contained dashboard HTML module for CLI embedding.   |
| `test`             | `@attest/web`         | Runs focused dashboard unit tests.                                   |
| `typecheck`        | `@attest/web`         | Type-checks web source without emitting files.                       |
