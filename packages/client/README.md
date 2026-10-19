# @attest/client

Host this next to an async agent. It accepts attest's `callback` trigger, answers `202`, runs your
handler and posts the `attest.agent-completion` back. Depends only on `@attest/contracts` and zod.

```ts
import { createAgentRunner } from '@attest/client';
import { serveAgentRunner } from '@attest/client/node';
import { createPiHandler } from '@attest/client/pi';

const runner = createAgentRunner({ handler: createPiHandler(), triggerToken: 'change-me' });

await serveAgentRunner(runner, { port: 8790 });
```

- `@attest/client`: `createAgentRunner`, a Web-standard `fetch` handler for Node, Bun and Workers.
- `@attest/client/node`: `serveAgentRunner` over `node:http` and `collectArtifacts` for a directory.
- `@attest/client/pi`: `createPiHandler`, which drives `pi --mode rpc` and returns the final text,
  an `attest.trace` and the files Pi changed.

The [integration guide](../../docs/integrations/attest-client.md) covers the trigger and completion
contract, limits, error codes and the trace mapping. `examples/` has a runnable Pi runner and a Pi
extension that posts the completion from inside Pi.
