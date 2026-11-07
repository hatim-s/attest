import * as Effect from 'effect/Effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttestCliError } from '../errors/cli-error.js';
import { cliResultSchema, parseWithSchemaSync } from '@attest/contracts';
import { describe, expect, it } from 'vitest';
import { runCli } from '../run-cli.js';
import { nonInteractive } from './support/cli-test-support.js';

describe('native command cancellation', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'preserves web failures after %s while joining shutdown',
    async (signal) => {
      const directory = await mkdtemp(join(tmpdir(), 'attest-web-failure-'));
      const lines: string[] = [];
      const errors: string[] = [];

      try {
        const exitCode = await runCli(['web', '--no-open'], {
          workingDirectory: directory,
          interaction: nonInteractive(),
          io: {
            error: (line) => errors.push(line),
            output: (line) => {
              if (line.startsWith('Attest web:')) {
                process.emit(signal);
                throw new AttestCliError('cli_usage', 'Readiness failed after signal.');
              }

              lines.push(line);
            },
          },
        });

        expect(exitCode).toBe(2);
        expect(lines).toEqual([]);
        expect(errors).toEqual([expect.stringContaining('Readiness failed after signal.')]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'joins resources before publishing %s cancellation',
    async (signal) => {
      const listeners = { int: process.listeners('SIGINT'), term: process.listeners('SIGTERM') };
      const lines: string[] = [];
      let released = false;
      let publishedBeforeRelease = false;
      let admitted = 0;

      const exitCode = await runCli(['cloud', 'project', 'list', '--output', 'json'], {
        interaction: nonInteractive(),
        io: {
          error: () => {},
          output: (line) => {
            publishedBeforeRelease = !released;
            lines.push(line);
          },
        },
        services: {
          cloud: {
            authenticatedCloudClient: () =>
              Effect.scoped(
                Effect.gen(function* () {
                  yield* Effect.acquireRelease(
                    Effect.sync(() => {
                      admitted += 1;
                      queueMicrotask(() => process.emit(signal));
                    }),
                    () =>
                      Effect.promise(async () => {
                        await new Promise<void>((resolve) => setTimeout(resolve, 5));
                        released = true;
                      }),
                  );

                  return yield* Effect.never;
                }),
              ),
          },
        },
      });

      expect(exitCode).toBe(130);
      expect(admitted).toBe(1);
      expect(released).toBe(true);
      expect(publishedBeforeRelease).toBe(false);
      expect(lines).toHaveLength(1);
      expect(parseWithSchemaSync(cliResultSchema, JSON.parse(lines[0]!))).toMatchObject({
        ok: false,
        error: { code: 'cancelled' },
      });
      expect(process.listeners('SIGINT')).toEqual(listeners.int);
      expect(process.listeners('SIGTERM')).toEqual(listeners.term);
    },
  );
});
