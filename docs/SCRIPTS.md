# Package scripts

Run workspace commands from the repository root. To run one package script, use
`bun run --cwd packages/<package> <script>`.

| Script             | Root behavior                                                      |
| ------------------ | ------------------------------------------------------------------ |
| `build`            | Builds packages in dependency order through Turborepo.             |
| `typecheck`        | Builds dependencies and checks each package's source.              |
| `lint`             | Checks TypeScript, TSX, and package import boundaries with ESLint. |
| `lint:fix`         | Applies available ESLint fixes.                                    |
| `test`             | Runs package tests serially to isolate process fixtures.           |
| `generate:schemas` | Regenerates JSON schemas from contracts.                           |
| `format:check`     | Checks repository formatting with Prettier.                        |
| `format`           | Formats repository files with Prettier.                            |

## Application packages

| Script      | Packages                             | Behavior                                                                                                             |
| ----------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `build`     | contracts, core, runtime, local, cli | Compiles production artifacts into `dist`, excluding tests. Runtime and local build their referenced packages first. |
| `typecheck` | contracts, core, runtime, local, cli | Checks source and test types without emitting files.                                                                 |
| `test`      | contracts                            | Runs protocol and schema tests.                                                                                      |
| `test`      | core                                 | Runs domain comparison, import, trace, and record tests.                                                             |
| `test`      | runtime                              | Runs execution, metric, cancellation, and transport tests with one worker.                                           |
| `test`      | local                                | Runs project, transaction, SQLite, application, and local server tests with one worker.                              |
| `test`      | cli                                  | Runs terminal command and packed-install acceptance tests with one worker.                                           |

## Supporting packages

| Script      | Package     | Behavior                                                                  |
| ----------- | ----------- | ------------------------------------------------------------------------- |
| `generate`  | schemas     | Writes public JSON schemas from the contract registry.                    |
| `typecheck` | schemas     | Checks generation and artifact validation code.                           |
| `test`      | schemas     | Checks the generated schema file set and exact content against contracts. |
| `build`     | web         | Builds the self-contained dashboard HTML module for local embedding.      |
| `typecheck` | web         | Checks dashboard source and tests.                                        |
| `test`      | web         | Runs focused dashboard tests.                                             |
| `dev`       | site        | Serves the marketing page at `http://127.0.0.1:8735`.                     |
| `build`     | site        | Copies the marketing page into `dist/index.html`.                         |
| `preview`   | site        | Serves the built marketing page on the same loopback address.             |
| `typecheck` | site        | Checks the site build and preview scripts.                                |
| `test`      | conformance | Runs public protocol fixtures and fake-agent checks.                      |
| `test:fuzz` | conformance | Runs parser fuzzing with `FUZZ=1`.                                        |
| `typecheck` | conformance | Checks conformance source.                                                |

Conformance commands run with `bun run --cwd conformance <script>`.
