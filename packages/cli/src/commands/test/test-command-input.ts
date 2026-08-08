import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import {
  CASE_SCHEMA_VERSION,
  COMMAND_REQUEST_SCHEMA_VERSION,
  commandRequestSchema,
  testCaseSchema,
  type CommandRequest,
  type TestCase,
} from '@attest/contracts';

import { AttestCliError } from '../../errors.js';
import { serializeCanonicalJson, type JsonValue } from '../../project/canonical-project.js';

type NativeCaseFormat = 'json' | 'jsonl';
type TestCaseInput = Omit<TestCase, 'id'> & { id?: string };
type NativeCaseLocation = { kind: 'line' | 'row'; number: number };
type NativeCaseDiagnostic = {
  code: string;
  destination_path: string;
  hint: string;
  line?: number;
  message: string;
  row?: number;
  source_field: string;
};

type ReadTextOptions = {
  pathLabel: string;
  readStdin: () => Promise<string>;
  source: string;
  workingDirectory: string;
};

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const requestDiagnostics = (
  issues: readonly { message: string; path: PropertyKey[] }[],
): JsonValue => issues.map(({ message, path }) => ({ message, path: `/${path.join('/')}` }));

/** Validates a flag- or JSON-built request through the same published command schema. */
const validateCommandRequest = <TCommand extends CommandRequest['command']>(
  command: TCommand,
  value: unknown,
): Extract<CommandRequest, { command: TCommand }> => {
  const parsed = commandRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'The command request does not match its schema.', {
      hint: `Run \`attest help ${command.replaceAll('.', ' ')} --output json\` and repair the input.`,
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  if (parsed.data.command !== command) {
    throw new AttestCliError('cli_usage', 'The command request targets another command.', {
      path: '/command',
      hint: `Set \`command\` to \`${command}\`.`,
    });
  }
  return parsed.data as Extract<CommandRequest, { command: TCommand }>;
};

/** Reads a request or import source without echoing its filesystem path or contents on failure. */
const readTextSource = async (options: ReadTextOptions): Promise<string> => {
  try {
    return options.source === '-'
      ? await options.readStdin()
      : await readFile(resolve(options.workingDirectory, options.source), 'utf8');
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'Could not read the requested input source.', {
      path: options.pathLabel,
      hint: 'Pass a readable UTF-8 file or `-` for stdin.',
      cause: error,
    });
  }
};

/** Parses one strict versioned mutation request for the expected command. */
const readCommandRequest = async <TCommand extends CommandRequest['command']>(
  command: TCommand,
  source: string,
  options: Omit<ReadTextOptions, 'pathLabel' | 'source'>,
): Promise<Extract<CommandRequest, { command: TCommand }>> => {
  const text = await readTextSource({ ...options, pathLabel: '--from-json', source });
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'The command request is not valid JSON.', {
      path: '--from-json',
      hint: `Provide one ${COMMAND_REQUEST_SCHEMA_VERSION} document.`,
      cause: error,
    });
  }

  return validateCommandRequest(command, value);
};

/** Encodes bytes with the unpadded lowercase RFC 4648 base32 alphabet. */
const encodeBase32 = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let encoded = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) encoded += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return encoded;
};

/** Generates the ratified move-stable id from logical case content only. */
const generateCaseId = (testCase: TestCaseInput): string => {
  const logicalContent: JsonValue = {
    input: testCase.input,
    ...(testCase.expected === undefined ? {} : { expected: testCase.expected }),
    ...(testCase.params === undefined ? {} : { params: testCase.params }),
  };
  const digest = createHash('sha256').update(serializeCanonicalJson(logicalContent)).digest();
  return `case-${encodeBase32(digest).slice(0, 16)}`;
};

const diagnosticLocation = (
  location: NativeCaseLocation,
): Pick<NativeCaseDiagnostic, 'line' | 'row'> =>
  location.kind === 'line' ? { line: location.number } : { row: location.number };

const escapePointerSegment = (segment: PropertyKey): string =>
  String(segment).replaceAll('~', '~0').replaceAll('/', '~1');

/** Expands aggregate unknown-key issues into one addressable JSON Pointer per source field. */
const destinationPathsForIssue = (issue: {
  code: string;
  keys?: readonly string[];
  path: PropertyKey[];
}): string[] => {
  const paths =
    issue.code === 'unrecognized_keys' && issue.keys !== undefined
      ? issue.keys.map((key) => [...issue.path, key])
      : [issue.path];
  return paths
    .map((path) => (path.length === 0 ? '' : `/${path.map(escapePointerSegment).join('/')}`))
    .sort();
};

/** Validates one native record without short-circuiting validation of later records. */
const normalizeCase = (
  value: unknown,
  location: NativeCaseLocation,
): { diagnostics: NativeCaseDiagnostic[]; testCase?: TestCase } => {
  const input =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as TestCaseInput)
      : undefined;
  // A placeholder allows strict case validation to report authored fields before id generation.
  const parsed = testCaseSchema.safeParse(
    input === undefined ? value : { ...input, id: input.id ?? 'case-pending' },
  );
  if (!parsed.success) {
    return {
      diagnostics: parsed.error.issues.flatMap((issue) =>
        destinationPathsForIssue(issue).map((destinationPath) => ({
          code: issue.code,
          destination_path: destinationPath,
          hint: `Repair this field to match ${CASE_SCHEMA_VERSION}.`,
          message: issue.message,
          source_field: destinationPath === '' ? '<record>' : destinationPath,
          ...diagnosticLocation(location),
        })),
      ),
    };
  }
  return {
    diagnostics: [],
    testCase:
      input?.id === undefined ? { ...parsed.data, id: generateCaseId(parsed.data) } : parsed.data,
  };
};

const inferNativeCaseFormat = (source: string, explicit?: string): NativeCaseFormat => {
  if (explicit !== undefined) {
    if (explicit === 'json' || explicit === 'jsonl') return explicit;
    throw new AttestCliError('cli_usage', 'CLI2.7 imports only native JSON or JSONL cases.', {
      path: '--format',
      hint: 'Use `--format json` or `--format jsonl`; tabular mapping lands separately.',
    });
  }
  if (source === '-') {
    throw new AttestCliError('cli_missing_input', 'Stdin imports require an explicit format.', {
      path: '--format',
      hint: 'Pass `--format json` or `--format jsonl`.',
    });
  }
  const extension = extname(source).toLowerCase();
  if (extension === '.json') return 'json';
  if (extension === '.jsonl') return 'jsonl';
  throw new AttestCliError('cli_usage', 'Could not infer a native case import format.', {
    path: '--format',
    hint: 'Use a .json/.jsonl source or pass `--format json|jsonl`.',
  });
};

/** Parses complete native JSON or JSONL case input before any project mutation begins. */
const readNativeCases = async (options: {
  format?: string;
  readStdin: () => Promise<string>;
  source: string;
  workingDirectory: string;
}): Promise<{ cases: TestCase[]; format: NativeCaseFormat; sourceHash: string }> => {
  const format = inferNativeCaseFormat(options.source, options.format);
  const text = await readTextSource({ ...options, pathLabel: '<source>' });
  const records: { location: NativeCaseLocation; value: unknown }[] = [];
  const diagnostics: NativeCaseDiagnostic[] = [];
  if (format === 'json') {
    try {
      const parsed = JSON.parse(text) as unknown;
      const parsedRecords: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      parsedRecords.forEach((value, index) =>
        records.push({ location: { kind: 'row', number: index + 1 }, value }),
      );
    } catch (error: unknown) {
      throw new AttestCliError('project_invalid', 'The native JSON case source is invalid.', {
        path: '<source>',
        hint: 'Provide one case object or an array of case objects.',
        cause: error,
      });
    }
  } else {
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (line.trim().length === 0) continue;
      try {
        records.push({
          location: { kind: 'line', number: index + 1 },
          value: JSON.parse(line) as unknown,
        });
      } catch {
        diagnostics.push({
          code: 'invalid_json',
          destination_path: '',
          hint: 'Provide exactly one JSON case object on this nonblank line.',
          line: index + 1,
          message: 'Line is not valid JSON.',
          source_field: '<line>',
        });
      }
    }
  }
  const cases: TestCase[] = [];
  for (const record of records) {
    const normalized = normalizeCase(record.value, record.location);
    diagnostics.push(...normalized.diagnostics);
    if (normalized.testCase !== undefined) cases.push(normalized.testCase);
  }
  if (diagnostics.length > 0) {
    throw new AttestCliError('project_invalid', 'Imported case validation failed.', {
      path: '<source>',
      hint: 'Repair every listed native case diagnostic, then retry the all-or-nothing import.',
      details: { diagnostics },
    });
  }
  return {
    cases,
    format,
    sourceHash: createHash('sha256').update(text).digest('hex'),
  };
};

/** Parses one JSON-valued flag without reflecting sensitive authored values into diagnostics. */
const parseJsonFlag = (value: string | undefined, path: string): JsonValue | undefined => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', `${path} must contain valid JSON.`, {
      path,
      hint: 'Pass a JSON scalar, array, or object.',
      cause: error,
    });
  }
};

export {
  generateCaseId,
  parseJsonFlag,
  readCommandRequest,
  readNativeCases,
  validateCommandRequest,
  type NativeCaseFormat,
  type TestCaseInput,
};
