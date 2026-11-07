# @attest/executor

Agent invocation and case isolation for Node 22+ and Bun 1.4+. This package has no dependency on Attest's evaluation scheduler, metric providers, database, or CLI.

```ts
import * as Effect from 'effect/Effect';
import { invokeAgent } from '@attest/executor';

const result = await Effect.runPromise(
  invokeAgent(
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
  ),
);
```

`invokeAgent` handles CLI and envelope HTTP agents. Named adapters handle mapped HTTP, streams, WebSockets, background services, JSONL bridges, and Vercel Sandbox. Invocation results retain attempts, diagnostics, envelope validation, and transport failures separately.

`justBashIsolation` and `vercelSandboxIsolation` create one `CaseEnvironment` per case. The factories and every environment method return native Effects. The owning application executes them and owns disposal. Both environments expose `exec`, `readFile`, `writeFile`, `beginFinalization`, and `dispose`. File API paths and `files` seed-map keys are relative to the case workspace. Absolute paths and paths that escape with `..` are rejected.

The runtime calls `beginFinalization` before final case hooks. This cancels and drains work admitted during the run, then gives final hooks a separate deadline. `finalizationTimeoutMs` defaults to `timeoutMs` for just-bash and `commandTimeoutMs` for Vercel, which both default to 60 seconds. Standalone callers that need final-hook access should make the same transition and must execute `dispose` during release, for example with `Effect.acquireUseRelease`.

The just-bash environment uses the portable interpreter with a fresh virtual filesystem. It does not run native binaries, mount host files, or enable network commands. Use Vercel Sandbox for coding agents that need real processes. Vercel credentials follow the SDK's OIDC or access-token configuration. Vercel command output divides `outputBytes` evenly between stdout and stderr, so their combined retained output cannot exceed the configured cap. If the SDK rejects a command, the environment stops and rejects later operations because the SDK cannot confirm that the remote command exited. Final hooks cannot recover files from that poisoned VM.

## HTTP execution on hosted workers

Import `@attest/executor/http` to avoid loading process and sandbox implementations.
This entry point uses Node crypto, util and Buffer, so Cloudflare Workers require
`nodejs_compat`. `invokeNativeHttpAgent` validates a native envelope and returns
one recorded attempt. Supply `httpFetch` for host-guarded network I/O.

For configured JSON, polling, SSE and JSONL agents, pass the transports returned
by `createFetchHttpTransports(guardedFetch)` to `invokeMappedHttpAgent` or
`invokeStreamingAgent`. Set `retries: 0` to override authored retry budgets.
The shared adapters retain request mapping, terminal extraction, contract
validation, evidence limits, idle deadlines and cancellation. Without injected
transports, local callers retain DNS-pinned Node HTTP behavior.

The invocation operations return Effect values. A custom `StreamHttpTransport`
returns an Effect of `{ status, headers, read, close }`; `read` admits one chunk
read and `close` must stop the body, join accepted reads and confirm release.
Both are Effects. The old Promise/AsyncIterable/cancel stream contract is removed.
The foreign `guardedFetch` function itself still returns a Promise.
`StreamCleanupError` retains the completed invocation if its outer signal cleanup
fails. Body cleanup failures retain terminal status and bounded evidence on the
failed attempt; neither condition permits replay.

S4a changes stream retry behavior: a body failure after successful 2xx headers
is never retried, even if no event arrived. A connection reset or idle timeout
does not prove the agent stopped its work.

The fetch adapter does not validate or pin DNS. The caller's `guardedFetch` must
enforce endpoint policy on every request, including polling and same-origin
redirects, and honor the supplied cancellation signal. Fetch has no separate TCP connection
phase, so these adapters use `first_byte_ms` for the header deadline. The host
must enforce `connect_ms` when its networking API supports that phase. Passing global fetch
without a guard is suitable only for trusted local endpoints.

## Callback receiver lifetime

`createLoopbackCompletionReceiver` returns an Effect requiring a Scope. Keep the
scope open across all callback invocations. Receiver `register` and `close`, and
each registration's `completion` and `release`, are native Effects. Stop admission
and join accepted invocations before closing the receiver and disposing its scope.
Explicit close reports cleanup failure; the scope fallback captures it and the
concrete receiver exposes the retained Exit through `cleanup` after disposal.

The loopback receiver has 16 request workers and room for 128 queued requests.
Excess requests receive `503` with `internal_error`. Each accepted request has a
30-second lifetime including queue time; incoming data does not extend it. Close
is terminal, so construct a new scoped receiver for a later session.
Closing before an acknowledged completion reaches its waiting invocation can
fail that invocation; join admitted invocations before closing.

`invokeCallbackAgent`, `triggerCallbackAgent` and `completeCallbackAgent` also
return Effects. `CallbackCleanupError` retains a completed invocation when cleanup
fails, including earlier attempts and bounded evidence. These TypeScript changes
do not change trigger or completion wire messages. Custom hosted receivers must
implement the native contract; no Promise compatibility layer is provided.

WebSocket session APIs return native Effects. `startWebSocketAgent` requires a
Scope; keep it alive until all invocations join and `close` completes. Prefer
`withWebSocketAgent(agent, options, use)` for one complete session lifetime.
`WebSocketCleanupError.result` retains completed case evidence after a per-case
close failure. A request is never replayed after a socket write, even if the peer
has not acknowledged it. Known pre-dispatch opening failures retain their retry
attempts. This is stricter than the authored acknowledgement retry ceiling.
