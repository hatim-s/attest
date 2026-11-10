# @attest/client

Host this next to an async agent. It accepts attest's `callback` trigger, answers `202`, runs your
handler and posts the `attest.agent-completion` back. Depends only on `@attest/contracts` and Effect.

```ts
import { Effect } from 'effect';
import { createAgentRunner } from '@attest/client';
import { serveAgentRunner } from '@attest/client/node';
import { createPiHandler } from '@attest/client/pi';

/** Owns the listener and accepted invocations until an operator requests shutdown. */
const program = Effect.scoped(
  Effect.gen(function* () {
    const triggerToken = process.env.ATTEST_TRIGGER_TOKEN;

    // A missing token is a deployment mistake, so stop the process instead of recovering.
    if (triggerToken === undefined)
      return yield* Effect.die(new Error('Set ATTEST_TRIGGER_TOKEN.'));

    const runner = yield* createAgentRunner({
      handler: createPiHandler({
        model: process.env.PI_MODEL,
        env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      }),
      triggerToken,
    });

    const served = yield* serveAgentRunner(runner, { port: 8790 });
    console.log(`Pi runner listening on ${served.url}`);
    yield* Effect.callback<void>((resume) => {
      const stop = () => resume(Effect.void);
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);

      return Effect.sync(() => {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      });
    });
    yield* served.close();
    yield* runner.close();
  }),
);

await Effect.runPromise(program);
```

- `@attest/client`: `createAgentRunner`, a scoped native runner with a Web-standard request operation for Node, Bun and Workers.
- `@attest/client/node`: `serveAgentRunner` over `node:http` and `collectArtifacts` for a directory.
- `@attest/client/pi`: `createPiHandler`, which drives `pi --mode rpc` and returns the final text,
  an `attest.trace` and the files Pi changed.

A handler's failure type is `AgentHandlerError`. Handlers written against the earlier contract
failed with `Error`, and they no longer typecheck. Fail with
`new AgentHandlerError({ message, cause })` instead, and map your own tagged errors with
`Effect.mapError((e) => new AgentHandlerError({ message: e.message, cause: e }))`. Only `message` is
sent to attest, as a `handler_failed` completion; `cause` stays local in `runner.receipts`. The Pi
`workspace` option follows the same rule.

```ts
import { Effect } from 'effect';
import { AgentHandlerError, type AgentHandler } from '@attest/client';

const handler: AgentHandler = (invocation) =>
  Effect.tryPromise({
    try: () => callMyAgent(invocation.input),
    catch: (cause) => new AgentHandlerError({ message: 'The agent call failed.', cause }),
  }).pipe(Effect.map((output) => ({ output })));
```

The Pi handler requires `pi` and `ps` on `PATH`. Its process-group cleanup check uses
`ps -axo pgid=,stat=`; install procps on Linux. Missing or unsupported `ps` makes cleanup
unconfirmed, so the runner reports `handler_failed` even if Pi completed successfully.

The [integration guide](../../docs/integrations/attest-client.md) covers the trigger and completion
contract, limits, error codes and the trace mapping. `examples/` has a runnable Pi runner and a Pi
extension that posts the completion from inside Pi.

The runner accepts trigger bodies up to 10 MiB by default. If an agent resource sets
`limits.request_bytes` higher, set `requestBodyLimitBytes` on `createAgentRunner` to a
matching or larger byte count. The receiver limit must be a positive safe integer.
