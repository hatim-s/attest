/**
 * Serves the Pi handler on http://127.0.0.1:8790 for an attest `callback` agent. Attest posts the
 * trigger here; the runner answers 202, runs `pi --mode rpc` in a fresh temporary workspace and
 * posts the completion (final text, trace, changed files) to the callback URL.
 *
 *   PI_MODEL=anthropic/claude-sonnet-5-5 ATTEST_TRIGGER_TOKEN=change-me bun examples/pi-runner.ts
 *
 * Pi reads provider credentials from its usual environment variables. Configure the attest trigger
 * to send `Authorization: Bearer $ATTEST_TRIGGER_TOKEN`.
 */
import { createAgentRunner } from '@attest/client';
import { serveAgentRunner } from '@attest/client/node';
import { createPiHandler } from '@attest/client/pi';

const triggerToken = process.env.ATTEST_TRIGGER_TOKEN;

if (triggerToken === undefined) throw new Error('Set ATTEST_TRIGGER_TOKEN.');

const runner = createAgentRunner({
  handler: createPiHandler({ model: process.env.PI_MODEL }),
  triggerToken,
});

const served = await serveAgentRunner(runner, { port: 8790 });

console.log(`Pi runner listening on ${served.url}`);

process.once('SIGINT', () => {
  // Stop taking triggers, abort running Pi processes, then post their cancelled completions.
  void served.close().then(() => runner.close());
});
