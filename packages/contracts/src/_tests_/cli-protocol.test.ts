import { parseWithSchema } from '../schema/parse.js';
import { describe, expect, it } from 'vitest';

import {
  cliErrorCatalogSchema,
  cliEventSchema,
  cliHelpSchema,
  cliResultSchema,
} from '../cli/protocol.js';
import {
  CLI_ERROR_CATALOG_SCHEMA_ID,
  CLI_EVENT_SCHEMA_ID,
  CLI_HELP_SCHEMA_ID,
  CLI_RESULT_SCHEMA_ID,
} from '../schema/identifiers.js';

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
  request_schema: 'attest.command-request#test.case.import',
  examples: ['attest test case import smoke ./cases.jsonl --output json'],
  constraints: [],
};

describe('CLI protocol contracts', () => {
  it('accepts strict success and failure result envelopes', () => {
    const success = {
      schema: CLI_RESULT_SCHEMA_ID,
      ok: true,
      command: 'test.case.import',
      project_hash_before: 'a'.repeat(64),
      project_hash_after: 'b'.repeat(64),
      result: { imported: 3 },
      warnings: [],
    };

    const failure = {
      schema: CLI_RESULT_SCHEMA_ID,
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

    expect(parseWithSchema(cliResultSchema, success).ok).toBe(true);
    expect(parseWithSchema(cliResultSchema, failure).ok).toBe(true);
    expect(parseWithSchema(cliResultSchema, { ...success, extra: true }).ok).toBe(false);
  });

  it('accepts deterministic event fields and rejects invalid sequence data', () => {
    const event = {
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: 0,
      time: '2026-08-07T12:00:00.000Z',
      event: 'case_started',
      data: { case_id: 'refund-basic' },
    };

    expect(parseWithSchema(cliEventSchema, event).ok).toBe(true);
    expect(parseWithSchema(cliEventSchema, { ...event, sequence: -1 }).ok).toBe(false);
    expect(parseWithSchema(cliEventSchema, { ...event, event: 'CaseStarted' }).ok).toBe(false);
  });

  it('requires every machine-help required field', () => {
    const help = { schema: CLI_HELP_SCHEMA_ID, command: helpCommand };

    expect(parseWithSchema(cliHelpSchema, help).ok).toBe(true);
    expect(
      parseWithSchema(cliHelpSchema, {
        ...help,
        command: { ...helpCommand, request_schema: undefined },
      }).ok,
    ).toBe(false);
    expect(
      parseWithSchema(cliHelpSchema, {
        ...help,
        command: {
          ...helpCommand,
          options: [{ ...helpCommand.options[0], conflicts: undefined }],
        },
      }).ok,
    ).toBe(false);
  });

  it('requires stable failure exit codes and repair guidance in the error catalog', () => {
    const catalog = {
      schema: CLI_ERROR_CATALOG_SCHEMA_ID,
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

    expect(parseWithSchema(cliErrorCatalogSchema, catalog).ok).toBe(true);
    expect(
      parseWithSchema(cliErrorCatalogSchema, {
        ...catalog,
        errors: [{ ...catalog.errors[0], exit_code: 0 }],
      }).ok,
    ).toBe(false);
  });
});
