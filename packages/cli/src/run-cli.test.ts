import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from './run-cli.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('runCli', () => {
  it('renders help without terminating the caller', async () => {
    const output: string[] = [];
    const exitCode = await runCli(['--help'], {
      io: { output: (message) => output.push(message), error: (message) => output.push(message) },
    });

    expect(exitCode).toBe(0);
    expect(output.join('')).toContain('run [options]');
  });

  it('returns an actionable config discovery error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-cli-command-'));
    temporaryDirectories.push(directory);
    const errors: string[] = [];

    const exitCode = await runCli(['run'], {
      workingDirectory: directory,
      io: { output: () => undefined, error: (message) => errors.push(message) },
    });

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toContain('config_not_found');
  });

  it('converts OTLP JSON through the nested trace command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-cli-command-'));
    temporaryDirectories.push(directory);
    const traceId = '00112233445566778899aabbccddeeff';
    await writeFile(
      join(directory, 'trace.json'),
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId,
                    spanId: '0011223344556677',
                    parentSpanId: '',
                    name: 'agent.run',
                    startTimeUnixNano: '1786059000000000000',
                    endTimeUnixNano: '1786059001000000000',
                    status: { code: 1 },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const output: string[] = [];

    const exitCode = await runCli(['trace', 'convert', 'trace.json'], {
      workingDirectory: directory,
      io: { output: (message) => output.push(message), error: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
      trace_id: traceId,
      spans: [{ kind: 'agent' }],
    });
  });

  it('emits one machine-readable run document', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-cli-command-'));
    temporaryDirectories.push(directory);
    const agentPath = join(directory, 'agent.mjs');
    await writeFile(
      agentPath,
      "let s='';process.stdin.setEncoding('utf8');for await(const c of process.stdin)s+=c;const r=JSON.parse(s);process.stdout.write(JSON.stringify({protocol:'attest.agent/v1alpha1',output:r.input}));\n",
    );
    await writeFile(
      join(directory, 'attest.config.json'),
      JSON.stringify({
        config_version: 1,
        agent: { type: 'cli', command: [process.execPath, './agent.mjs'] },
        suites: [{ name: 'smoke', metrics: [], cases: [{ id: 'one', input: 'ok' }] }],
        metrics: [],
      }),
    );
    const output: string[] = [];

    const exitCode = await runCli(['run', '--format', 'json'], {
      workingDirectory: directory,
      io: { output: (message) => output.push(message), error: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
      run: { status: 'completed', summary: { passedCases: 1 } },
    });
  });
});
