import * as Effect from 'effect/Effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttestCliError } from '../errors/cli-error.js';
import { spawn } from 'node:child_process';
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

describe.each(['node', 'bun'])('stdin cancellation on %s', (runtime) => {
  it.each(
    [
      ['agent', 'add', '--from-json', '-'],
      ['agent', 'test', '--from-json', '-'],
      ['agent', 'test', 'a1', '--input-file', '-'],
      ['metric', 'test', '--from-json', '-'],
    ].flatMap((args) => (['SIGINT', 'SIGTERM'] as const).map((signal) => ({ args, signal }))),
  )('closes stdin for $args after $signal', async ({ args, signal }) => {
    const entry = new URL('../../dist/run-cli.js', import.meta.url).href;

    const script = `
    import { runCli } from ${JSON.stringify(entry)};
    let ready = false;
    process.stdin.on('newListener', (event) => {
      if (event === 'readable' && !ready) {
        ready = true;
        queueMicrotask(() => process.stdout.write('READY\\n'));
      }
    });
    process.exitCode = await runCli(${JSON.stringify([...args, '--output', 'json'])});
  `;

    const child = spawn(runtime, ['--input-type=module', '--eval', script], { stdio: 'pipe' });
    let output = '';
    let sent = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 4000);

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();

      if (!sent && output.includes('READY\n')) {
        sent = true;
        child.kill(signal);
      }
    });
    child.stderr.resume();

    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }).finally(() => {
      clearTimeout(timer);
      child.kill();
    });

    expect(timedOut).toBe(false);
    expect(exit).toBe(130);
    const result = output.split('\n').find((line) => line.startsWith('{'));
    expect(result).toBeDefined();
    expect(parseWithSchemaSync(cliResultSchema, JSON.parse(result!))).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
  });
});
