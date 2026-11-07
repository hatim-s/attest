import { spawn } from 'node:child_process';
import { cliResultSchema, parseWithSchemaSync } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

// Spawns real Node and Bun processes against the built CLI, so it runs with acceptance after the build.
describe.each(['node', 'bun'])('stdin cancellation on %s', (runtime) => {
  it.each(
    [
      ['agent', 'add', '--from-json', '-'],
      ['agent', 'test', '--from-json', '-'],
      ['agent', 'test', 'a1', '--input-file', '-'],
      ['metric', 'test', '--from-json', '-'],
    ].flatMap((args) => (['SIGINT', 'SIGTERM'] as const).map((signal) => ({ args, signal }))),
  )('closes stdin for $args after $signal', async ({ args, signal }) => {
    const entry = new URL('../../../dist/run-cli.js', import.meta.url).href;

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
