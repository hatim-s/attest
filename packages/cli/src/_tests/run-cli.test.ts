import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cliErrorCatalogSchema, cliResultSchema } from '@attest/contracts';
import { openStore } from '@attest/core';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../run-cli.js';

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
    expect(output.join('')).toContain('eval');
    expect(output.join('')).not.toContain('\n  run [options]');
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
      schema: 'attest.cli-result',
      ok: true,
      command: 'help',
      project_hash_before: null,
      project_hash_after: null,
      result: {
        schema: 'attest.cli-help',
        command: {
          path: ['trace', 'convert'],
          name: 'convert',
          summary: 'Convert an OTLP/HTTP JSON export to attest.trace JSON.',
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
          request_schema: null,
          examples: [],
          constraints: [],
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
      schema: 'attest.cli-result',
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
      schema: 'attest.cli-result',
      ok: true,
      command: 'errors',
      result: {
        schema: 'attest.cli-errors',
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

  it('returns an actionable project discovery error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-cli-command-'));
    temporaryDirectories.push(directory);
    const errors: string[] = [];

    const exitCode = await runCli(['eval', 'run', 'smoke'], {
      workingDirectory: directory,
      io: { output: () => undefined, error: (message) => errors.push(message) },
    });

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toContain('project_not_found');
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

    const globalOutput: string[] = [];
    expect(
      await runCli(['--output', 'json', 'trace', 'convert', 'trace.json'], {
        workingDirectory: directory,
        io: { output: (message) => globalOutput.push(message), error: () => undefined },
      }),
    ).toBe(0);
    expect(JSON.parse(globalOutput.at(-1) ?? '{}')).toMatchObject({ trace_id: traceId });
    await expect(readFile(join(directory, 'json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const fileOutput: string[] = [];
    expect(
      await runCli(['trace', 'convert', 'trace.json', '--output', 'converted.json'], {
        workingDirectory: directory,
        io: { output: (message) => fileOutput.push(message), error: () => undefined },
      }),
    ).toBe(0);
    expect(fileOutput.join('')).toContain('converted.json');
    expect(JSON.parse(await readFile(join(directory, 'converted.json'), 'utf8'))).toMatchObject({
      trace_id: traceId,
    });
  });

  it('does not expose the removed top-level run alias', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-cli-command-'));
    temporaryDirectories.push(directory);
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(['run', '--format', 'json'], {
      workingDirectory: directory,
      io: { output: (message) => output.push(message), error: (message) => errors.push(message) },
    });

    expect(exitCode).toBe(2);
    expect(output).toEqual([]);
    expect(errors.join('')).toContain("unknown command 'run'");
    await expect(readFile(join(directory, '.attest', 'runs.db'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps command output options scoped to their artifact and format semantics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-cli-output-'));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, '.attest'));
    const storePath = join(directory, '.attest', 'runs.db');
    const store = await openStore(storePath);
    const first = await store.runs.createRun({
      schemaId: 'attest.project',
      configHash: 'first',
      configJson: '{}',
    });
    await store.runs.finalizeRun(first.id, 'completed');
    const second = await store.runs.createRun({
      schemaId: 'attest.project',
      configHash: 'second',
      configJson: '{}',
    });
    await store.runs.finalizeRun(second.id, 'completed');
    await store.close();

    const globalReportOutput: string[] = [];
    expect(
      await runCli(['--output', 'json', 'report', first.id, '--store', storePath], {
        workingDirectory: directory,
        io: { output: (message) => globalReportOutput.push(message), error: () => undefined },
      }),
    ).toBe(0);
    expect(globalReportOutput.join('')).toContain(`${first.id}.html`);
    await expect(readFile(join(directory, 'json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const reportOutput: string[] = [];
    const absoluteReportPath = join(directory, 'report.json');
    expect(
      await runCli(['report', first.id, '--store', storePath, '--output', absoluteReportPath], {
        // On macOS this pairs a /var-authored destination with its /private/var project alias.
        workingDirectory: await realpath(directory),
        io: { output: (message) => reportOutput.push(message), error: () => undefined },
      }),
    ).toBe(0);
    expect(reportOutput.join('')).toContain('report.json');
    expect(await readFile(absoluteReportPath, 'utf8')).toContain('<!doctype html>');

    const diffOutput: string[] = [];
    expect(
      await runCli(['diff', first.id, second.id, '--store', storePath, '--format', 'json'], {
        workingDirectory: directory,
        io: { output: (message) => diffOutput.push(message), error: () => undefined },
      }),
    ).toBe(0);
    expect(JSON.parse(diffOutput[0] ?? '{}')).toMatchObject({
      summary: { baseRunId: first.id, candidateRunId: second.id },
    });

    const usageOutput: string[] = [];
    const usageErrors: string[] = [];
    expect(
      await runCli(['run', '--output', 'json'], {
        workingDirectory: directory,
        io: {
          output: (message) => usageOutput.push(message),
          error: (message) => usageErrors.push(message),
        },
      }),
    ).toBe(2);
    expect(usageOutput).toEqual([]);
    expect(usageErrors.join('')).toContain("unknown command 'run'");
  });

  it('retrieves the schema id advertised by JSON help from the generated registry', async () => {
    const listOutput: string[] = [];
    expect(
      await runCli(['schema', 'list', '--output', 'json'], {
        io: { output: (message) => listOutput.push(message), error: () => undefined },
      }),
    ).toBe(0);
    const listed = cliResultSchema.parse(JSON.parse(listOutput[0] ?? '{}') as unknown);
    if (!listed.ok) throw new Error('Expected schema.list success.');
    expect(listed.command).toBe('schema.list');
    const listResult = listed.result as { items: { file: string; id: string }[] };
    expect(listResult.items.find(({ id }) => id === 'attest.command-request')).toEqual({
      file: 'command-request.json',
      id: 'attest.command-request',
    });

    const printOutput: string[] = [];
    expect(
      await runCli(['schema', 'print', 'attest.command-request', '--output', 'json'], {
        io: { output: (message) => printOutput.push(message), error: () => undefined },
      }),
    ).toBe(0);
    expect(JSON.parse(printOutput[0] ?? '{}')).toMatchObject({
      ok: true,
      command: 'schema.print',
      result: {
        file: 'command-request.json',
        id: 'attest.command-request',
        schema: { $schema: 'https://json-schema.org/draft/2020-12/schema' },
      },
    });

    const repeatedOutput: string[] = [];
    await runCli(['schema', 'print', 'attest.command-request', '--output', 'json'], {
      io: { output: (message) => repeatedOutput.push(message), error: () => undefined },
    });
    expect(repeatedOutput).toEqual(printOutput);

    const missingOutput: string[] = [];
    expect(
      await runCli(['schema', 'print', 'missing', '--output', 'json'], {
        io: { output: (message) => missingOutput.push(message), error: () => undefined },
      }),
    ).toBe(1);
    expect(JSON.parse(missingOutput[0] ?? '{}')).toMatchObject({
      command: 'schema.print',
      error: { code: 'resource_not_found' },
    });
  });

  it('advertises positional common options without changing command-specific semantics', async () => {
    const output: string[] = [];
    await runCli(['help', '--output', 'json'], {
      io: { output: (message) => output.push(message), error: () => undefined },
    });
    const document = cliResultSchema.parse(JSON.parse(output[0] ?? '{}') as unknown);
    if (!document.ok) throw new Error('Expected help success.');
    const result = document.result as {
      command: {
        options: { name: string }[];
        subcommands: { name: string; options: { name: string }[] }[];
      };
    };
    expect(result.command.options.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['output', 'project', 'non-interactive']),
    );
    const subcommands = new Map(
      result.command.subcommands.map((command) => [command.name, command]),
    );
    expect(subcommands.has('run')).toBe(false);
    expect(subcommands.has('eval')).toBe(true);
    expect(subcommands.get('diff')?.options.map(({ name }) => name)).toContain('format');
    expect(subcommands.get('report')?.options.map(({ name }) => name)).toContain('output');
    expect(subcommands.get('trace')?.options.map(({ name }) => name)).not.toContain('output');
  });
});
