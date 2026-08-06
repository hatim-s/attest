# Scripts

| Name               | Package             | What it does                                                                  |
| ------------------ | ------------------- | ----------------------------------------------------------------------------- |
| `build`            | root                | Runs each package build task through Turborepo.                               |
| `typecheck`        | root                | Runs workspace TypeScript checks through Turborepo.                           |
| `lint`             | root                | Runs ESLint across the repository (root-level, not per-package).              |
| `test`             | root                | Runs workspace tests through Turborepo.                                       |
| `generate:schemas` | root                | Regenerates the published JSON Schemas from `@attest/contracts`.              |
| `format:check`     | root                | Checks repository formatting with Prettier (root-level).                      |
| `format`           | root                | Formats repository files with Prettier.                                       |
| `lint:fix`         | root                | Applies ESLint fixes across the repository.                                   |
| `build`            | `@attest/contracts` | Compiles contract artifacts to `dist/`.                                       |
| `typecheck`        | `@attest/contracts` | Type-checks contract source without emitting files.                           |
| `test`             | `@attest/contracts` | Runs contract tests, allowing no tests during scaffolding.                    |
| `build`            | `@attest/core`      | Compiles core artifacts to `dist/`.                                           |
| `typecheck`        | `@attest/core`      | Type-checks core source without emitting files.                               |
| `test`             | `@attest/core`      | Runs core tests, allowing no tests during scaffolding.                        |
| `build`            | `@attest/cli`       | Compiles CLI artifacts to `dist/`.                                            |
| `typecheck`        | `@attest/cli`       | Type-checks CLI source without emitting files.                                |
| `test`             | `@attest/cli`       | Runs CLI tests, allowing no tests during scaffolding.                         |
| `typecheck`        | `@attest/schemas`   | Verifies generated-schema package TypeScript settings without emitting files. |
| `test`             | `@attest/schemas`   | Runs schema tests, allowing no tests during scaffolding.                      |
| `typecheck`        | `@attest/web`       | Type-checks web source without emitting files.                                |
| `test`             | `@attest/web`       | Runs web tests, allowing no tests during scaffolding.                         |
