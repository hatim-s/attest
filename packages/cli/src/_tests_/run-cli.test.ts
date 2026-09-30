import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cliErrorCatalogSchema, cliHelpSchema } from '@attest/contracts';
import { openStore } from '@attest/local/store';
import { describe, expect, it } from 'vitest';

import { runCommand, runJson, temporaryDirectory } from './support/cli-test-support.js';

describe('runCli', () => {
  it('renders help without terminating the caller', async () => {
    const help = await runCommand(process.cwd(), ['--help']);

    expect(help.exitCode).toBe(0);
    const text = [...help.output, ...help.errors].join('');
    expect(text).toContain('eval');
    expect(text).not.toContain('\n  run [options]');
  });

  it('emits one complete deterministic JSON help document', async () => {
    const help = await runJson(process.cwd(), ['help', 'trace', 'convert']);
    const repeated = await runJson(process.cwd(), ['help', 'trace', 'convert']);

    expect(help.exitCode).toBe(0);
    expect(repeated.output).toEqual(help.output);
    expect(help.document).toEqual({
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
    const help = await runJson(process.cwd(), ['help', 'unknown']);

    expect(help.exitCode).toBe(2);
    expect(help.document).toEqual({
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
    const errors = await runJson(process.cwd(), ['errors']);

    expect(errors.exitCode).toBe(0);
    expect(errors.document).toMatchObject({ ok: true, command: 'errors' });
    if (!errors.document.ok) throw new Error('Expected the errors command to succeed.');
    const catalog = cliErrorCatalogSchema.parse(errors.document.result);
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
    const unknown = await runCommand(process.cwd(), ['not-a-command']);

    expect(unknown.exitCode).toBe(2);
    expect(unknown.output).toEqual([]);
    expect(unknown.errors.join('')).toContain("unknown command 'not-a-command'");
  });

  it('returns an actionable project discovery error', async () => {
    const directory = await temporaryDirectory('attest-cli-command-');
    const run = await runCommand(directory, ['eval', 'run', 'smoke']);

    expect(run.exitCode).toBe(1);
    expect(run.errors.join('\n')).toContain('project_not_found');
  });

  it('keeps trace, report, and diff output flags off the root --output', async () => {
    const directory = await temporaryDirectory('attest-cli-output-');
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
    const rootOutput = await runCommand(directory, [
      '--output',
      'json',
      'trace',
      'convert',
      'trace.json',
    ]);
    expect(rootOutput.exitCode).toBe(0);
    expect(JSON.parse(rootOutput.output.at(-1) ?? '')).toMatchObject({ trace_id: traceId });
    await expect(readFile(join(directory, 'json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const fileOutput = await runCommand(directory, [
      'trace',
      'convert',
      'trace.json',
      '--output',
      'converted.json',
    ]);
    expect(fileOutput.exitCode).toBe(0);
    expect(fileOutput.output.join('')).toContain('converted.json');
    expect(JSON.parse(await readFile(join(directory, 'converted.json'), 'utf8'))).toMatchObject({
      trace_id: traceId,
    });

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

    const rootReport = await runCommand(directory, [
      '--output',
      'json',
      'report',
      first.id,
      '--store',
      storePath,
    ]);
    expect(rootReport.exitCode).toBe(0);
    expect(rootReport.output.join('')).toContain(`${first.id}.html`);
    await expect(readFile(join(directory, 'json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const absoluteReportPath = join(directory, 'report.json');
    // On macOS this pairs a /var-authored destination with its /private/var project alias.
    const report = await runCommand(await realpath(directory), [
      'report',
      first.id,
      '--store',
      storePath,
      '--output',
      absoluteReportPath,
    ]);
    expect(report.exitCode).toBe(0);
    expect(report.output.join('')).toContain('report.json');
    expect(await readFile(absoluteReportPath, 'utf8')).toContain('<!doctype html>');

    const diff = await runCommand(directory, [
      'diff',
      first.id,
      second.id,
      '--store',
      storePath,
      '--format',
      'json',
    ]);
    expect(diff.exitCode).toBe(0);
    expect(JSON.parse(diff.output[0] ?? '')).toMatchObject({
      summary: { baseRunId: first.id, candidateRunId: second.id },
    });
  });

  it('retrieves the schema id advertised by JSON help from the generated registry', async () => {
    const listed = await runJson(process.cwd(), ['schema', 'list']);
    expect(listed.exitCode).toBe(0);
    expect(listed.document).toMatchObject({
      ok: true,
      command: 'schema.list',
      result: {
        items: expect.arrayContaining([
          { file: 'command-request.json', id: 'attest.command-request' },
        ]) as unknown,
      },
    });

    const printed = await runJson(process.cwd(), ['schema', 'print', 'attest.command-request']);
    expect(printed.exitCode).toBe(0);
    expect(printed.document).toMatchObject({
      ok: true,
      command: 'schema.print',
      result: {
        file: 'command-request.json',
        id: 'attest.command-request',
        schema: { $schema: 'https://json-schema.org/draft/2020-12/schema' },
      },
    });
    const repeated = await runJson(process.cwd(), ['schema', 'print', 'attest.command-request']);
    expect(repeated.output).toEqual(printed.output);

    const missing = await runJson(process.cwd(), ['schema', 'print', 'missing']);
    expect(missing.exitCode).toBe(1);
    expect(missing.document).toMatchObject({
      command: 'schema.print',
      error: { code: 'resource_not_found' },
    });
  });

  it('advertises positional common options without changing command-specific semantics', async () => {
    const help = await runJson(process.cwd(), ['help']);
    if (!help.document.ok) throw new Error('Expected help success.');
    const { command } = cliHelpSchema.parse(help.document.result);

    expect(command.options.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['output', 'project', 'non-interactive']),
    );
    const subcommands = new Map(
      command.subcommands.map((subcommand) => [subcommand.name, subcommand]),
    );
    expect(subcommands.has('run')).toBe(false);
    expect(subcommands.has('eval')).toBe(true);
    expect(subcommands.get('diff')?.options.map(({ name }) => name)).toContain('format');
    expect(subcommands.get('report')?.options.map(({ name }) => name)).toContain('output');
    expect(subcommands.get('trace')?.options.map(({ name }) => name)).not.toContain('output');
  });
});
