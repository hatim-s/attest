# Scripts

| Name               | Package             | What it does                                                 |
| ------------------ | ------------------- | ------------------------------------------------------------ |
| `build`            | root                | Runs each package build task through Turborepo.              |
| `typecheck`        | root                | Runs workspace TypeScript checks through Turborepo.          |
| `lint`             | root                | Runs ESLint across the repository.                           |
| `test`             | root                | Runs package test tasks through Turborepo.                   |
| `generate:schemas` | root                | Regenerates published JSON Schemas from `@attest/contracts`. |
| `format:check`     | root                | Checks repository formatting with Prettier.                  |
| `format`           | root                | Formats repository files with Prettier.                      |
| `lint:fix`         | root                | Applies ESLint fixes across the repository.                  |
| `build`            | `@attest/contracts` | Compiles contract artifacts to `dist/`.                      |
| `typecheck`        | `@attest/contracts` | Type-checks contract source without emitting files.          |
| `test`             | `@attest/contracts` | Runs contract tests.                                         |
| `build`            | `@attest/core`      | Compiles core artifacts to `dist/`.                          |
| `typecheck`        | `@attest/core`      | Type-checks core source without emitting files.              |
| `build`            | `@attest/cli`       | Compiles CLI artifacts to `dist/`.                           |
| `typecheck`        | `@attest/cli`       | Type-checks CLI source without emitting files.               |
| `test`             | `@attest/schemas`   | Validates generated JSON Schema artifacts.                   |
| `typecheck`        | `@attest/web`       | Type-checks web source without emitting files.               |
