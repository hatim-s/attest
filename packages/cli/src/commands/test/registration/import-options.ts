import {
  caseImportOptionsSchema,
  type CommandRequest,
  type DatasetImportMapping,
} from '@attest/contracts';
import { Option, type Command } from 'commander';

import { AttestCliError } from '../../../errors/cli-error.js';
import { addMutationOptions, collect, type MutationCliOptions } from '../../shared/cli-options.js';

type ImportPolicy = Extract<CommandRequest, { command: 'test.case.import' }>['import'];

type ImportCliOptions = MutationCliOptions & {
  dedupe?: ImportPolicy['dedupe'];
  format?: ImportPolicy['format'];
  key?: string;
  map?: string[];
  onConflict?: ImportPolicy['on_conflict'];
  parseJson?: string[];
  recordsPointer?: string;
  sync?: ImportPolicy['sync'];
};

const IMPORT_POLICY = caseImportOptionsSchema.shape;

/** Help defaults local applies when the import policy leaves them out. */
const IMPORT_OPTION_HELP = {
  'on-conflict': { default: 'error' },
  sync: { default: 'append' },
};

/** Adds the mutation options plus the CSV, JSON, and JSONL import policy flags. */
const addImportOptions = (command: Command): Command =>
  addMutationOptions(command)
    .addOption(
      new Option('--format <format>', 'stdin or explicit import format').choices(
        IMPORT_POLICY.format.unwrap().options,
      ),
    )
    .option('--map <destination=source>', 'explicit field mapping; repeatable', collect)
    .option('--parse-json <source>', 'parse one structured CSV column as JSON; repeatable', collect)
    .option('--records-pointer <pointer>', 'RFC 6901 pointer to a JSON records array')
    .option('--key <source>', 'stable source key for incremental imports')
    .addOption(
      new Option('--dedupe <basis>', 'within-import dedupe basis').choices(
        IMPORT_POLICY.dedupe.unwrap().options,
      ),
    )
    .addOption(
      new Option('--on-conflict <policy>', 'existing-case conflict policy').choices(
        IMPORT_POLICY.on_conflict.unwrap().options,
      ),
    )
    .addOption(
      new Option('--sync <policy>', 'incremental import policy').choices(
        IMPORT_POLICY.sync.unwrap().options,
      ),
    );

/** Splits one `destination=source` mapping at its first equals sign. */
const parseMapping = (value: string): DatasetImportMapping => {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    throw new AttestCliError('cli_usage', 'Import mappings must use destination=source.', {
      path: '--map',
      hint: 'For example, pass --map input.question=prompt.',
    });
  }
  return { destination: value.slice(0, separator), source: value.slice(separator + 1) };
};

/** Maps the import flags onto the request's `import` policy. */
const importRequestFields = (options: ImportCliOptions): ImportPolicy => ({
  ...(options.format === undefined ? {} : { format: options.format }),
  ...(options.map === undefined ? {} : { mapping: options.map.map(parseMapping) }),
  ...(options.parseJson === undefined ? {} : { parse_json: options.parseJson }),
  ...(options.recordsPointer === undefined ? {} : { records_pointer: options.recordsPointer }),
  ...(options.key === undefined ? {} : { key: options.key }),
  ...(options.dedupe === undefined ? {} : { dedupe: options.dedupe }),
  ...(options.onConflict === undefined ? {} : { on_conflict: options.onConflict }),
  ...(options.sync === undefined ? {} : { sync: options.sync }),
});

export { IMPORT_OPTION_HELP, addImportOptions, importRequestFields, type ImportCliOptions };
