import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  COMMAND_REQUEST_SCHEMA_ID,
  evalCancelRequestSchema,
  evalRunRequestSchema,
  type EvalCancelRequest,
  type EvalOutputMode,
  type EvalRunRequest,
  type JsonValue,
} from '@attest/contracts';

import { AttestCliError } from '../../errors/index.js';
import { parseDuration } from '../agent/agent-request.js';

type EvalPrompt = (question: string, options?: { signal?: AbortSignal }) => Promise<string>;

type EvalRequestContext = {
  interactive: boolean;
  onOutputMode?: (output: EvalOutputMode) => void;
  prompt: EvalPrompt;
  readStdin: () => Promise<string>;
  signal?: AbortSignal;
  workingDirectory: string;
};

type EvalRunRequestFields = {
  all?: boolean;
  baseline?: string;
  caseIds?: readonly string[];
  concurrency?: string;
  fromJson?: string;
  junit?: string;
  output?: EvalOutputMode;
  tags?: readonly string[];
  testIds?: readonly string[];
  timeout?: string;
  watch?: boolean;
};

type EvalCancelRequestFields = {
  fromJson?: string;
  output?: Exclude<EvalOutputMode, 'jsonl'>;
  runId?: string;
};

const requestDiagnostics = (
  issues: readonly { message: string; path: PropertyKey[] }[],
): JsonValue => issues.map(({ message, path }) => ({ message, path: `/${path.join('/')}` }));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Reads one JSON request source without allowing filesystem errors to escape the CLI contract. */
const readRequestSource = async (source: string, context: EvalRequestContext): Promise<unknown> => {
  let text: string;
  try {
    text =
      source === '-'
        ? await context.readStdin()
        : await readFile(resolve(context.workingDirectory, source), 'utf8');
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'Could not read the eval command request.', {
      path: '--from-json',
      hint: 'Pass a readable UTF-8 JSON file or `-` for stdin.',
      cause: error,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'The eval command request is not valid JSON.', {
      path: '--from-json',
      hint: `Provide one ${COMMAND_REQUEST_SCHEMA_ID} document.`,
      cause: error,
    });
  }
};

/** Records a structured mode before strict validation so malformed requests still render correctly. */
const observeOutputMode = (value: unknown, context: EvalRequestContext): void => {
  if (!isRecord(value)) return;
  const output = value.output;
  if (output === 'human' || output === 'json' || output === 'jsonl') {
    context.onOutputMode?.(output);
  }
};

const supplied = (value: unknown): boolean =>
  value !== undefined && (!Array.isArray(value) || value.length > 0);

/** Rejects overlapping JSON and flag request sources in stable flag-name order. */
const assertNoJsonSourceConflicts = (
  fromJson: string | undefined,
  fields: Readonly<Record<string, unknown>>,
): void => {
  if (fromJson === undefined) return;
  const conflicts = Object.entries(fields)
    .filter(([, value]) => supplied(value))
    .map(([name]) => name)
    .sort();
  if (conflicts.length === 0) return;
  throw new AttestCliError('cli_usage', 'Eval command request sources overlap.', {
    path: '--from-json',
    hint: 'Pass request values through either flags and arguments or --from-json, not both.',
    details: { conflicting_fields: conflicts },
  });
};

/** Converts one guided selection answer into the same all-or-test-id fields used by flags. */
const promptForSelection = async (
  context: EvalRequestContext,
): Promise<{ all: true } | { test_ids: string[] }> => {
  const answer = (
    await context.prompt('Test ids (space-separated) or all [all]: ', {
      signal: context.signal,
    })
  ).trim();
  if (answer.length === 0 || answer.toLowerCase() === 'all') return { all: true };
  const testIds = answer.split(/[\s,]+/u).filter((value) => value.length > 0);
  return { test_ids: testIds };
};

/** Validates one normalized run request through the frozen public contract. */
const validateEvalRunRequest = (value: unknown): EvalRunRequest => {
  const parsed = evalRunRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'The eval run request does not match its schema.', {
      hint: 'Run `attest help eval run --output json` and repair every diagnostic.',
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  return parsed.data;
};

/** Normalizes flags, a strict JSON request, or the selection wizard into one run request. */
const createEvalRunRequest = async (
  fields: EvalRunRequestFields,
  context: EvalRequestContext,
): Promise<EvalRunRequest> => {
  assertNoJsonSourceConflicts(fields.fromJson, {
    '--all': fields.all,
    '--baseline': fields.baseline,
    '--case': fields.caseIds,
    '--concurrency': fields.concurrency,
    '--junit': fields.junit,
    '--output': fields.output,
    '--tag': fields.tags,
    '--timeout': fields.timeout,
    '--watch': fields.watch,
    '<test-id>': fields.testIds,
  });
  if (fields.fromJson !== undefined) {
    const value = await readRequestSource(fields.fromJson, context);
    observeOutputMode(value, context);
    return validateEvalRunRequest(value);
  }

  if (fields.all === true && supplied(fields.testIds)) {
    throw new AttestCliError('cli_usage', '`--all` conflicts with explicit test ids.', {
      path: '--all',
      hint: 'Pass either --all or one or more test ids.',
      details: { conflicting_fields: ['--all', '<test-id>'] },
    });
  }
  const output = fields.output ?? 'human';
  context.onOutputMode?.(output);
  if (fields.watch === true && output !== 'human') {
    throw new AttestCliError('cli_usage', '`--watch` requires human output.', {
      path: '--watch',
      hint: 'Remove --watch or use --output human.',
      details: { conflicting_fields: ['--output', '--watch'] },
    });
  }

  let selection: { all: true } | { test_ids: string[] };
  if (fields.all === true) selection = { all: true };
  else if (supplied(fields.testIds)) selection = { test_ids: [...(fields.testIds ?? [])] };
  else if (context.interactive) selection = await promptForSelection(context);
  else {
    throw new AttestCliError('cli_missing_input', 'Eval run selection is missing.', {
      path: '<test-id>|--all',
      hint: 'Pass one or more test ids, --all, or a complete --from-json request.',
    });
  }

  return validateEvalRunRequest({
    schema: COMMAND_REQUEST_SCHEMA_ID,
    command: 'eval.run',
    ...selection,
    ...(fields.caseIds === undefined ? {} : { case_ids: [...fields.caseIds] }),
    ...(fields.tags === undefined ? {} : { tags: [...fields.tags] }),
    ...(fields.concurrency === undefined ? {} : { concurrency: Number(fields.concurrency) }),
    ...(fields.timeout === undefined ? {} : { timeout_ms: parseDuration(fields.timeout) }),
    ...(fields.baseline === undefined ? {} : { baseline_run_id: fields.baseline }),
    ...(fields.junit === undefined ? {} : { junit_path: fields.junit }),
    output,
    ...(fields.watch === undefined ? {} : { watch: fields.watch }),
  });
};

/** Validates one normalized cancellation request through the frozen public contract. */
const validateEvalCancelRequest = (value: unknown): EvalCancelRequest => {
  const parsed = evalCancelRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'The eval cancel request does not match its schema.', {
      hint: 'Run `attest help eval cancel --output json` and repair every diagnostic.',
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  return parsed.data;
};

/** Normalizes cancellation flags or one strict JSON request into the frozen request shape. */
const createEvalCancelRequest = async (
  fields: EvalCancelRequestFields,
  context: EvalRequestContext,
): Promise<EvalCancelRequest> => {
  assertNoJsonSourceConflicts(fields.fromJson, {
    '--output': fields.output,
    '<run-id>': fields.runId,
  });
  if (fields.fromJson !== undefined) {
    const value = await readRequestSource(fields.fromJson, context);
    observeOutputMode(value, context);
    return validateEvalCancelRequest(value);
  }
  const runId = fields.runId?.trim();
  if (runId === undefined || runId.length === 0) {
    throw new AttestCliError('cli_missing_input', 'Eval cancellation requires a run id.', {
      path: '<run-id>',
      hint: 'Pass the immutable eval run id or a complete --from-json request.',
    });
  }
  const output = fields.output ?? 'human';
  context.onOutputMode?.(output);
  return validateEvalCancelRequest({
    schema: COMMAND_REQUEST_SCHEMA_ID,
    command: 'eval.cancel',
    run_id: runId,
    output,
  });
};

export {
  createEvalCancelRequest,
  createEvalRunRequest,
  validateEvalCancelRequest,
  validateEvalRunRequest,
  type EvalCancelRequestFields,
  type EvalPrompt,
  type EvalRequestContext,
  type EvalRunRequestFields,
};
