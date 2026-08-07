import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cliErrorCatalogSchema, cliResultSchema } from '@attest/contracts';
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

  it('emits one complete deterministic JSON help document', async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(['help', 'trace', 'convert', '--output', 'json'], {
      io: { output: (message) => output.push(message), error: (message) => errors.push(message) },
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(output).toHaveLength(1);
    const repeatedOutput: string[] = [];
    await runCli(['help', 'trace', 'convert', '--output', 'json'], {
      io: { output: (message) => repeatedOutput.push(message), error: () => undefined },
    });
    expect(repeatedOutput).toEqual(output);
    expect(JSON.parse(output[0] ?? '{}')).toEqual({
      schema: 'attest.cli-result/v1',
      ok: true,
      command: 'help',
      project_hash_before: null,
      project_hash_after: null,
      result: {
        schema: 'attest.cli-help/v1',
        command: {
          path: ['trace', 'convert'],
          name: 'convert',
          summary: 'Convert an OTLP/HTTP JSON export to attest.trace/v1alpha1 JSON.',
          usage: 'attest trace convert [options] <input>',
          arguments: [
            {
              name: 'input',
              usage: '<input>',
              description: 'OTLP JSON input path',
              required: true,
              variadic: false,
              choices: [],
              default: null,
            },
          ],
          options: [
            {
              name: 'trace-id',
              flags: '--trace-id <trace-id>',
              description: 'trace id to select from a multi-trace export',
              value_name: 'trace-id',
              required: false,
              repeatable: false,
              choices: [],
              default: null,
              conflicts: [],
              implies: [],
            },
            {
              name: 'output',
              flags: '-o, --output <path>',
              description: 'Attest trace output path',
              value_name: 'path',
              required: false,
              repeatable: false,
              choices: [],
              default: null,
              conflicts: [],
              implies: [],
            },
            {
              name: 'force',
              flags: '--force',
              description: 'replace an existing output file',
              value_name: null,
              required: false,
              repeatable: false,
              choices: [],
              default: null,
              conflicts: [],
              implies: [],
            },
          ],
          subcommands: [],
          aliases: [],
          alias_for: null,
          deprecated: null,
          request_schema: null,
          examples: [],
        },
      },
      warnings: [],
    });
  });

  it('returns one structured usage failure for an unknown JSON help path', async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(['help', 'unknown', '--output', 'json'], {
      io: { output: (message) => output.push(message), error: (message) => errors.push(message) },
    });

    expect(exitCode).toBe(2);
    expect(errors).toEqual([]);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? '{}')).toEqual({
      schema: 'attest.cli-result/v1',
      ok: false,
      command: 'help',
      error: {
        code: 'cli_usage',
        message: 'Unknown help path: unknown.',
        path: 'unknown',
        hint: 'Run `attest help --output json` to inspect registered command paths.',
        retryable: false,
      },
    });
  });

  it('exposes the same stable error registry through one JSON result', async () => {
    const output: string[] = [];

    const exitCode = await runCli(['errors', '--output', 'json'], {
      io: { output: (message) => output.push(message), error: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(output).toHaveLength(1);
    const document = cliResultSchema.parse(JSON.parse(output[0] ?? '{}') as unknown);
    expect(document).toMatchObject({
      schema: 'attest.cli-result/v1',
      ok: true,
      command: 'errors',
      result: {
        schema: 'attest.cli-errors/v1',
      },
    });
    if (!document.ok) {
      throw new Error('Expected the errors command to return a success document.');
    }
    const catalog = cliErrorCatalogSchema.parse(document.result);
    expect(catalog.errors.find(({ code }) => code === 'cli_usage')).toMatchObject({
      exit_code: 2,
      retryable: false,
    });
    expect(catalog.errors.find(({ code }) => code === 'project_changed')).toMatchObject({
      exit_code: 3,
      retryable: true,
    });
    expect(catalog.errors.find(({ code }) => code === 'cancelled')).toMatchObject({
      exit_code: 130,
      retryable: true,
    });
  });

  it('uses exit code 2 for Commander usage errors', async () => {
    const exitCode = await runCli(['not-a-command'], {
      io: { output: () => undefined, error: () => undefined },
    });

    expect(exitCode).toBe(2);
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
