import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { CancellationRegistry, registerEvalRun, unregisterEvalRun } from '../eval-cancellation.js';

/** Exercises real request files while keeping all PID and token identities owned by this test. */
test('fences stale cancellation requests and unregister against the replacement generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-cancel-generation-'));

  try {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* CancellationRegistry;
          const first = yield* registerEvalRun(root, 'owned-run');
          const second = yield* registerEvalRun(root, 'owned-run');
          yield* Effect.promise(() =>
            writeFile(
              second.requestPath,
              JSON.stringify({ run_id: 'owned-run', token: first.record.token }),
            ),
          );
          yield* Effect.sleep(75);
          expect(second.signal.aborted).toBe(false);
          yield* unregisterEvalRun(first);
          expect(registry.size).toBe(1);
          const current = yield* Effect.promise(() => readFile(second.path, 'utf8'));
          expect(current).toContain(second.record.token);
          yield* Effect.promise(() =>
            writeFile(
              second.requestPath,
              JSON.stringify({ run_id: 'owned-run', token: second.record.token }),
            ),
          );
          yield* Effect.sleep(75);
          expect(second.signal.aborted).toBe(true);
          yield* unregisterEvalRun(second);
          expect(registry.size).toBe(0);
        }),
      ).pipe(Effect.provideService(CancellationRegistry, new Map())),
    );

    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
