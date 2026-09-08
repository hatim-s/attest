# TypeScript integration

Use `@attest/contracts` to type and validate your agent's protocol. Use the CLI's
JSON interface when an application or coding agent needs to author projects and run
evaluations. Alpha packages use ESM and require Node.js 22.15 or newer.

Install the supplied alpha archives as described in the [README](../../README.md).
The examples below run in that installation directory. Declare `@attest/contracts`
as a direct dependency when your own package imports it.

## Write a native agent

Save this as `agent.ts` in a Bun project with `@attest/contracts` installed:

```typescript
import { agentRequestSchema, type AgentSuccessResponse } from '@attest/contracts';

/** Reads one invocation and returns its input as the agent output. */
async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;

  // stdin is untyped input; validate it once at the protocol boundary.
  const request = agentRequestSchema.parse(JSON.parse(input));
  const response = {
    protocol: 'attest.agent-invocation',
    output: request.input,
  } satisfies AgentSuccessResponse;

  process.stdout.write(JSON.stringify(response));
}

await main();
```

In an initialized Attest project, register and probe it:

```bash
npx attest agent add typed --argv-json '["bun","./agent.ts"]' --timeout 5s --output json
npx attest agent test typed --input '"hello"' --output json
```

The request is typed after parsing. Use `satisfies AgentSuccessResponse` to check
your returned object without discarding inference. Write diagnostic logs to stderr;
stdout must contain exactly one protocol response. Bun executes the TypeScript file
here. If using Node, compile it with your application's TypeScript build and register
the resulting JavaScript file instead.

The runner creates a process per invocation and closes stdin after one request.
See [native agents](native.md) for agent-reported errors and the
[agent protocol](../specs/agent-contract.md) for state and trace fields.

## Call the CLI from an application

`@attest/cli` exports `runCli` for callers that need an in-process entry point. It
accepts command arguments without a Node executable or script prefix, returns a
numeric exit code, and accepts output callbacks and an explicit working directory.

```typescript
import { runCli } from '@attest/cli';

const exitCode = await runCli(['project', 'validate', '--output', 'json'], {
  workingDirectory: process.cwd(),
  io: {
    output: (document) => process.stdout.write(`${document}\n`),
    error: (message) => process.stderr.write(`${message}\n`),
  },
});

process.exitCode = exitCode;
```

For process isolation, execute the installed `attest` binary with an argument array
and parse stdout. Keep stderr separate. Both approaches use the same
[command and result contracts](../cli/index.md#global-machine-contract). A completed
evaluation with a failing verdict returns exit code `1` and `ok: true`; an invocation
failure returns `ok: false`. Do not treat every nonzero exit as malformed output.

`@attest/core` exposes lower-level runners, metrics, stores, and diff functions. It
does not provide a single high-level `evaluate()` SDK. Those APIs and the in-process
CLI API can change during the alpha; pin matching package versions. Discover the
installed CLI contract with `attest help --output json` when building automation.

## Check a project before an evaluation

```bash
npx attest project validate --output json
npx attest agent test typed --input '"hello"' --output json
```

`project validate` checks authored files, hashes, schemas, and references. It does
not prove that an executable exists or that credentials and remote services work.
`agent test` invokes the selected agent, so choose an input suitable for that service.
Use [`metric test`](../cli/metrics.md) to check scoring separately, then run a small
evaluation before increasing the case count.
