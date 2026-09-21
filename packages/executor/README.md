# @attest/executor

Agent invocation and case isolation for Node 22+ and Bun 1.4+. This package has no dependency on Attest's evaluation scheduler, metric providers, database, or CLI.

```ts
import { invokeAgent } from '@attest/executor';

const result = await invokeAgent(
  { type: 'cli', command: [process.execPath, './agent.mjs'] },
  {
    protocol: 'attest.agent-invocation',
    run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    case_id: 'example',
    input: { prompt: 'Implement the requested change.' },
  },
  {
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 60_000,
    outputCapBytes: 1024 * 1024,
    retries: 0,
  },
);
```

`invokeAgent` handles CLI and envelope HTTP agents. Named adapters handle mapped HTTP, streams, WebSockets, background services, JSONL bridges, and Vercel Sandbox. Invocation results retain attempts, diagnostics, envelope validation, and transport failures separately.

`justBashIsolation` and `vercelSandboxIsolation` create one `CaseEnvironment` per case. Both expose `exec`, `readFile`, `writeFile`, `beginFinalization`, and `dispose`. File API paths and `files` seed-map keys are relative to the case workspace. Absolute paths and paths that escape with `..` are rejected.

The runtime calls `beginFinalization` before final case hooks. This cancels and drains work admitted during the run, then gives final hooks a separate deadline. `finalizationTimeoutMs` defaults to `timeoutMs` for just-bash and `commandTimeoutMs` for Vercel, which both default to 60 seconds. Standalone callers that need final-hook access should make the same transition and must dispose environments in `finally`.

The just-bash environment uses the portable interpreter with a fresh virtual filesystem. It does not run native binaries, mount host files, or enable network commands. Use Vercel Sandbox for coding agents that need real processes. Vercel credentials follow the SDK's OIDC or access-token configuration. Vercel command output divides `outputBytes` evenly between stdout and stderr, so their combined retained output cannot exceed the configured cap. If the SDK rejects a command, the environment stops and rejects later operations because the SDK cannot confirm that the remote command exited. Final hooks cannot recover files from that poisoned VM.

Executor exports previously imported from `@attest/runtime` now come from this package. Runtime owns evaluation hooks, scheduling, and metrics.
