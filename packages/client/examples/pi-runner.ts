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
