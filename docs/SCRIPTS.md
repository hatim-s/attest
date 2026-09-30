# Package scripts

Run workspace commands from the repository root. To run one package script, use
`bun run --cwd packages/<package> <script>`.

| Script             | Root behavior                                                               |
| ------------------ | --------------------------------------------------------------------------- |
| `build`            | Builds packages in dependency order through Turborepo.                      |
| `typecheck`        | Builds dependencies and checks each package's source.                       |
| `lint`             | Checks TypeScript, TSX, and package import boundaries with ESLint.          |
| `lint:fix`         | Applies available ESLint fixes.                                             |
| `test`             | Runs package tests serially to isolate process fixtures.                    |
| `test:portability` | Runs the compiled executor and runtime checks on Node and Bun. Build first. |
| `generate:schemas` | Regenerates JSON schemas from contracts.                                    |
| `format:check`     | Checks repository formatting with Prettier.                                 |
| `format`           | Formats repository files with Prettier.                                     |

## Application packages

| Script      | Packages                                       | Behavior                                                                                                             |
| ----------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `build`     | contracts, core, executor, runtime, local, cli | Compiles production artifacts into `dist`, excluding tests. Runtime and local build their referenced packages first. |
| `typecheck` | contracts, core, executor, runtime, local, cli | Checks source and test types without emitting files.                                                                 |
| `test`      | contracts                                      | Runs protocol and schema tests.                                                                                      |
| `test`      | core                                           | Runs domain comparison, import, trace, and record tests.                                                             |
| `test`      | executor                                       | Runs invocation, transport, and process-cleanup tests with one worker.                                               |
| `test:node` | executor                                       | Runs compiled executor acceptance checks on Node. Build executor first.                                              |
| `test:bun`  | executor                                       | Runs the same compiled executor checks on Bun. Build executor first.                                                 |
| `test`      | runtime                                        | Runs scheduling, lifecycle, isolation, metric, and cancellation tests with one worker.                               |
| `test`      | local                                          | Runs project, transaction, SQLite, application, and local server tests with one worker.                              |
| `test`      | cli                                            | Runs terminal command and packed-install acceptance tests with one worker.                                           |

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
| `typecheck` | site        | Checks the dev and preview server script.                                 |
| `test`      | conformance | Runs public protocol fixtures.                                            |
| `test:fuzz` | conformance | Runs parser fuzzing with `FUZZ=1`.                                        |
| `typecheck` | conformance | Checks conformance source.                                                |

Conformance commands run with `bun run --cwd conformance <script>`.

Runtime also provides `test:node` and `test:bun`. They run the same compiled eval pipeline on each host, including isolated case files, all case stages, and persistence. Build runtime first. The root `test:portability` script runs both packages' `test:node` and `test:bun`.
