# Attest

Attest runs evaluations against agents, records their results, and compares runs. Agents and custom metrics can be executables or HTTP services. Projects keep their configuration in versioned JSON resources and their run history in a local SQLite database.

```sh
bun install --frozen-lockfile
bun run build
node packages/cli/dist/cli.js --help
```

Use Node 22 or later and Bun 1.4 or later. See the [quickstart](docs/quickstart.md) for a complete evaluation and [CLI reference](docs/cli/index.md) for commands.

## Packages

| Package             | Responsibility                                                               |
| ------------------- | ---------------------------------------------------------------------------- |
| `@attest/contracts` | Versioned protocols and resource schemas                                     |
| `@attest/core`      | Domain records, comparison, import, trace conversion, and storage interfaces |
| `@attest/runtime`   | Agent execution, metrics, and evaluation scheduling                          |
| `@attest/local`     | Project files, SQLite, local evaluation, reports, and dashboard server       |
| `@attest/cli`       | Terminal commands, prompts, and output                                       |
| `@attest/web`       | Dashboard and embedded report UI                                             |
| `@attest/schemas`   | Generated JSON schemas for non-TypeScript consumers                          |
| `@attest/site`      | Marketing page                                                               |

The [architecture guide](docs/ARCHITECTURE.md) explains the dependency rules and where new code belongs. Cloud code can reuse contracts, core, and runtime without importing the CLI or local application.

## Development

```sh
bun run typecheck
bun run lint
bun run test
bun run format:check
```

The test command runs packages serially because process cleanup tests inspect the operating system's process table. Avoid running those suites concurrently. Tests use temporary projects and fake agents; they do not require provider credentials.

Run `bun run generate:schemas` after changing a public contract. Schema tests compare generated files with the authoritative definitions and fail when they differ.

See [package scripts](docs/SCRIPTS.md), [testing](docs/TESTING.md), and [contributing](CONTRIBUTING.md).
