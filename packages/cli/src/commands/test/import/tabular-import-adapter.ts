import { createReadStream } from 'node:fs';
import { extname, resolve } from 'node:path';

import type { CaseImportOptions, TestCase } from '@attest/contracts';
import {
  TabularImportError,
  collectBoundedImportSource,
  DEFAULT_IMPORT_LIMITS,
  discoverCsvHeaders,
  importTabularCases,
  type ImportFormat,
  type TabularImportResult,
} from '@attest/core';

import { AttestCliError } from '../../../errors.js';

type ImportCommandAdapterOptions = {
  collisionCases?: readonly TestCase[];
  collisionContexts?: Parameters<typeof importTabularCases>[0]['collisionContexts'];
  existingCases?: readonly TestCase[];
  importOptions: CaseImportOptions;
  preparedSource?: Uint8Array;
  readImportStdin: () => AsyncIterable<string | Uint8Array>;
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
  readImportStdin: () => AsyncIterable<string | Uint8Array>,
): Promise<Uint8Array> => {
  try {
    const chunks =
      source === '-'
        ? readImportStdin()
        : (createReadStream(resolve(workingDirectory, source)) as AsyncIterable<Uint8Array>);
    return await collectBoundedImportSource(chunks, DEFAULT_IMPORT_LIMITS.maxBytes);
  } catch (error: unknown) {
    if (error instanceof TabularImportError) throw error;
    throw new AttestCliError('cli_usage', 'Could not read the requested import source.', {
      path: '<source>',
      hint: 'Pass a readable UTF-8 CSV, JSON, or JSONL file, or `-` for stdin.',
      cause: error,
    });
  }
};

type PreparedImportSource = { csvHeaders: string[]; format: ImportFormat; source: Uint8Array };

/** Converts aggregate engine diagnostics into parity-safe human and structured CLI details. */
const toCliImportError = (error: TabularImportError): AttestCliError => {
  const humanDiagnostics = error.diagnostics
    .map((entry) => {
      const location = entry.line === undefined ? `row ${entry.row ?? '?'}` : `line ${entry.line}`;
      return `${location}, source ${entry.source_field}, destination ${entry.destination_path || '<record>'}: ${entry.code}: ${entry.message} ${entry.hint}`;
    })
    .join('\n');
  return new AttestCliError('project_invalid', error.message, {
    path: '<source>',
    hint: `Repair every listed diagnostic, then retry the all-or-nothing import.\n${humanDiagnostics}`,
    details: { diagnostics: error.diagnostics.map((entry) => ({ ...entry })) },
    cause: error,
  });
};

/** Reads one bounded source once so a guided preview and its confirmed write use identical bytes. */
const prepareImportSource = async (
  source: string,
  workingDirectory: string,
  readImportStdin: () => AsyncIterable<string | Uint8Array>,
  explicitFormat?: ImportFormat,
): Promise<PreparedImportSource> => {
  try {
    const format = inferImportFormat(source, explicitFormat);
    const boundedSource = await readImportSource(source, workingDirectory, readImportStdin);
    return {
      csvHeaders: format === 'csv' ? discoverCsvHeaders(boundedSource) : [],
      format,
      source: boundedSource,
    };
  } catch (error: unknown) {
    if (error instanceof TabularImportError) throw toCliImportError(error);
    throw error;
  }
};

/** Adapts a versioned CLI request to the reusable all-in-memory import engine. */
const runTabularImportAdapter = async (
  options: ImportCommandAdapterOptions,
): Promise<TabularImportResult> => {
  const format = inferImportFormat(options.source, options.importOptions.format);
  try {
    const source =
      options.preparedSource ??
      (await readImportSource(options.source, options.workingDirectory, options.readImportStdin));
    return importTabularCases({
      collisionCases: options.collisionCases,
      collisionContexts: options.collisionContexts,
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
      throw toCliImportError(error);
    }
    throw error;
  }
};

export {
  inferImportFormat,
  prepareImportSource,
  runTabularImportAdapter,
  type ImportCommandAdapterOptions,
  type PreparedImportSource,
};
