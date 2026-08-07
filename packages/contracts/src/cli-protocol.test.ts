import { describe, expect, it } from 'vitest';

import {
  cliErrorCatalogSchema,
  cliEventSchema,
  cliHelpSchema,
  cliResultSchema,
} from './cli-protocol.js';
import {
  CLI_ERROR_CATALOG_SCHEMA_VERSION,
  CLI_EVENT_SCHEMA_VERSION,
  CLI_HELP_SCHEMA_VERSION,
  CLI_RESULT_SCHEMA_VERSION,
} from './versions.js';

const helpCommand = {
  path: ['test', 'case', 'import'],
  name: 'import',
  summary: 'Import direct cases into a test.',
  usage: 'attest test case import <test-id> <path|-> [options]',
  arguments: [
    {
      name: 'test-id',
      usage: '<test-id>',
      description: 'test receiving the imported cases',
      required: true,
      variadic: false,
      choices: [],
      default: null,
    },
  ],
  options: [
    {
      name: 'output',
      flags: '--output <format>',
      description: 'output format',
      value_name: 'format',
      required: false,
      repeatable: false,
      choices: ['human', 'json'],
      default: 'human',
      conflicts: [],
      implies: ['non-interactive'],
    },
  ],
  subcommands: [],
  aliases: [],
  alias_for: null,
  deprecated: null,
  request_schema: 'attest.command-request/v2#test.case.import',
  examples: ['attest test case import smoke ./cases.jsonl --output json'],
};

describe('CLI protocol contracts', () => {
  it('accepts strict success and failure result envelopes', () => {
    const success = {
      schema: CLI_RESULT_SCHEMA_VERSION,
      ok: true,
      command: 'test.case.import',
      project_hash_before: 'a'.repeat(64),
      project_hash_after: 'b'.repeat(64),
      result: { imported: 3 },
      warnings: [],
    };
    const failure = {
      schema: CLI_RESULT_SCHEMA_VERSION,
      ok: false,
      command: 'test.case.import',
      error: {
        code: 'project_changed',
        message: 'The project changed after it was read.',
        hint: 'Retry with the current project hash.',
        retryable: true,
        details: { current_hash: 'b'.repeat(64) },
      },
    };

    expect(cliResultSchema.safeParse(success).success).toBe(true);
    expect(cliResultSchema.safeParse(failure).success).toBe(true);
    expect(cliResultSchema.safeParse({ ...success, extra: true }).success).toBe(false);
  });

  it('accepts deterministic event fields and rejects invalid sequence data', () => {
    const event = {
      schema: CLI_EVENT_SCHEMA_VERSION,
      sequence: 0,
      time: '2026-08-07T12:00:00.000Z',
      event: 'case_started',
      data: { case_id: 'refund-basic' },
    };

    expect(cliEventSchema.safeParse(event).success).toBe(true);
    expect(cliEventSchema.safeParse({ ...event, sequence: -1 }).success).toBe(false);
    expect(cliEventSchema.safeParse({ ...event, event: 'CaseStarted' }).success).toBe(false);
  });

  it('requires every machine-help compatibility field', () => {
    const help = { schema: CLI_HELP_SCHEMA_VERSION, command: helpCommand };

    expect(cliHelpSchema.safeParse(help).success).toBe(true);
    expect(
      cliHelpSchema.safeParse({
        ...help,
        command: { ...helpCommand, request_schema: undefined },
      }).success,
    ).toBe(false);
    expect(
      cliHelpSchema.safeParse({
        ...help,
        command: {
          ...helpCommand,
          options: [{ ...helpCommand.options[0], conflicts: undefined }],
        },
      }).success,
    ).toBe(false);
  });

  it('requires stable failure exit codes and repair guidance in the error catalog', () => {
    const catalog = {
      schema: CLI_ERROR_CATALOG_SCHEMA_VERSION,
      errors: [
        {
          code: 'cli_usage',
          meaning: 'The command line does not match the command grammar.',
          likely_causes: ['An option or argument is missing.'],
          retryable: false,
          exit_code: 2,
          repairs: ['attest help --output json'],
        },
      ],
    };

    expect(cliErrorCatalogSchema.safeParse(catalog).success).toBe(true);
    expect(
      cliErrorCatalogSchema.safeParse({
        ...catalog,
        errors: [{ ...catalog.errors[0], exit_code: 0 }],
      }).success,
    ).toBe(false);
  });
});
