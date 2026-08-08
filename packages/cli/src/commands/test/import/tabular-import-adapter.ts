import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import type { CaseImportOptions, TestCase } from '@attest/contracts';
import {
  TabularImportError,
  importTabularCases,
  type ImportFormat,
  type TabularImportResult,
} from '@attest/core';

import { AttestCliError } from '../../../errors.js';

type ImportCommandAdapterOptions = {
  collisionCases?: readonly TestCase[];
  existingCases?: readonly TestCase[];
  importOptions: CaseImportOptions;
  readStdin: () => Promise<string>;
  source: string;
  workingDirectory: string;
};

const inferImportFormat = (source: string, explicit?: ImportFormat): ImportFormat => {
  if (explicit !== undefined) return explicit;
  if (source === '-') {
    throw new AttestCliError('cli_missing_input', 'Stdin imports require an explicit format.', {
      path: '--format',
      hint: 'Pass --format csv|json|jsonl.',
    });
  }
  const extension = extname(source).toLowerCase();
  if (extension === '.csv') return 'csv';
  if (extension === '.json') return 'json';
  if (extension === '.jsonl') return 'jsonl';
  throw new AttestCliError('cli_usage', 'Could not infer the case import format.', {
    path: '--format',
    hint: 'Use a .csv/.json/.jsonl source or pass --format csv|json|jsonl.',
  });
};

/** Reads import bytes without retaining or reporting an absolute private source path. */
const readImportSource = async (
  source: string,
  workingDirectory: string,
  readStdin: () => Promise<string>,
): Promise<string | Uint8Array> => {
  try {
    return source === '-' ? await readStdin() : await readFile(resolve(workingDirectory, source));
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'Could not read the requested import source.', {
      path: '<source>',
      hint: 'Pass a readable UTF-8 CSV, JSON, or JSONL file, or `-` for stdin.',
      cause: error,
    });
  }
};

/** Adapts a versioned CLI request to the reusable all-in-memory import engine. */
const runTabularImportAdapter = async (
  options: ImportCommandAdapterOptions,
): Promise<TabularImportResult> => {
  const format = inferImportFormat(options.source, options.importOptions.format);
  const source = await readImportSource(
    options.source,
    options.workingDirectory,
    options.readStdin,
  );
  try {
    return importTabularCases({
      collisionCases: options.collisionCases,
      dedupe: options.importOptions.dedupe,
      existingCases: options.existingCases,
      format,
      keySource: options.importOptions.key,
      mappings: options.importOptions.mapping,
      onConflict: options.importOptions.on_conflict,
      parseJsonSources: options.importOptions.parse_json,
      recordsPointer: options.importOptions.records_pointer,
      source,
      sync: options.importOptions.sync,
    });
  } catch (error: unknown) {
    if (error instanceof TabularImportError) {
      throw new AttestCliError('project_invalid', error.message, {
        path: '<source>',
        hint: 'Repair every listed diagnostic, then retry the all-or-nothing import.',
        details: { diagnostics: error.diagnostics.map((entry) => ({ ...entry })) },
        cause: error,
      });
    }
    throw error;
  }
};

export { inferImportFormat, runTabularImportAdapter, type ImportCommandAdapterOptions };
