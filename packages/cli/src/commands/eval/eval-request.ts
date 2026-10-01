import {
  COMMAND_REQUEST_SCHEMA_ID,
  evalCancelRequestSchema,
  evalOutputModeSchema,
  evalRunRequestSchema,
  type EvalCancelRequest,
  type EvalOutputMode,
  type EvalRunRequest,
  type JsonValue,
} from '@attest/contracts';
import { parseDuration } from '@attest/local/agent';

import { AttestCliError } from '../../errors/cli-error.js';
import { assertNoRequestOverlap } from '../shared/command-request.js';
import { promptWithSignal, type PromptContext } from '../shared/required-input.js';

type EvalRunRequestFields = {
  all?: boolean;
  baseline?: string;
  caseIds?: readonly string[];
  concurrency?: string;
  datasetIds?: readonly string[];
  folders?: readonly string[];
  junit?: string;
  output?: EvalOutputMode;
  sample?: string;
  seed?: string;
  tags?: readonly string[];
  testIds?: readonly string[];
  timeout?: string;
  watch?: boolean;
};

type EvalCancelRequestFields = {
  output?: Exclude<EvalOutputMode, 'jsonl'>;
  runId?: string;
};

type SchemaIssue = { message: string; path: readonly PropertyKey[] };

/** Lists schema issues with JSON Pointer-style paths for the error `details`. */
const issueDiagnostics = (issues: readonly SchemaIssue[]): JsonValue =>
  issues.map(({ message, path }) => ({ message, path: `/${path.map(String).join('/')}` }));

/** Reads the `output` a request document asks for, even when the rest of it is invalid. */
const requestedOutput = (document: JsonValue): EvalOutputMode | undefined => {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return undefined;
  }
  const parsed = evalOutputModeSchema.safeParse(document.output);
  return parsed.success ? parsed.data : undefined;
};

/** Validates one eval run request from flags or `--from-json` through the published schema. */
const parseEvalRunRequest = (value: unknown): EvalRunRequest => {
  const parsed = evalRunRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'The eval run request does not match its schema.', {
      hint: 'Run `attest help eval run --output json` and repair every diagnostic.',
      details: { diagnostics: issueDiagnostics(parsed.error.issues) },
    });
  }
  return parsed.data;
};

/** Validates one eval cancel request from flags or `--from-json` through the published schema. */
const parseEvalCancelRequest = (value: unknown): EvalCancelRequest => {
  const parsed = evalCancelRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'The eval cancel request does not match its schema.', {
      hint: 'Run `attest help eval cancel --output json` and repair every diagnostic.',
      details: { diagnostics: issueDiagnostics(parsed.error.issues) },
    });
  }
  return parsed.data;
};

/** Rejects run flags beside `--from-json`, using the flag spellings in the conflict list. */
const assertNoRunFlags = (fromJson: string | undefined, fields: EvalRunRequestFields): void =>
  assertNoRequestOverlap(
    { fromJson },
    {
      '--all': fields.all,
      '--baseline': fields.baseline,
      '--case': fields.caseIds,
      '--concurrency': fields.concurrency,
      '--dataset': fields.datasetIds,
      '--folder': fields.folders,
      '--junit': fields.junit,
      '--output': fields.output,
      '--sample': fields.sample,
      '--seed': fields.seed,
      '--tag': fields.tags,
      '--timeout': fields.timeout,
      '--watch': fields.watch,
      '<test-id>': fields.testIds,
    },
  );

/** Rejects cancel flags beside `--from-json`. */
const assertNoCancelFlags = (fromJson: string | undefined, fields: EvalCancelRequestFields): void =>
  assertNoRequestOverlap({ fromJson }, { '--output': fields.output, '<run-id>': fields.runId });

/** Asks which tests to run; an empty answer or `all` selects every test. */
const promptForSelection = async (
  context: PromptContext,
): Promise<{ all: true } | { test_ids: string[] }> => {
  const question = 'Test ids (space-separated) or all [all]: ';
  const answer = (await promptWithSignal(context.prompt, question, context.signal)).trim();
  if (answer.length === 0 || answer.toLowerCase() === 'all') return { all: true };
  return { test_ids: answer.split(/[\s,]+/u).filter((value) => value.length > 0) };
};

/** Turns run flags, or the selection wizard when no tests were named, into one run request. */
const createEvalRunRequest = async (
  fields: EvalRunRequestFields,
  context: PromptContext,
): Promise<EvalRunRequest> => {
  const testIds = fields.testIds ?? [];
  if (fields.all === true && testIds.length > 0) {
    throw new AttestCliError('cli_usage', '`--all` conflicts with explicit test ids.', {
      path: '--all',
      hint: 'Pass either --all or one or more test ids.',
      details: { conflicting_fields: ['--all', '<test-id>'] },
    });
  }
  if (fields.seed !== undefined && fields.sample === undefined) {
    throw new AttestCliError('cli_usage', '`--seed` requires `--sample`.');
  }
  const output = fields.output ?? 'human';
  if (fields.watch === true && output !== 'human') {
    throw new AttestCliError('cli_usage', '`--watch` requires human output.', {
      path: '--watch',
      hint: 'Remove --watch or use --output human.',
      details: { conflicting_fields: ['--output', '--watch'] },
    });
  }

  let selection: { all: true } | { test_ids: string[] };
  if (fields.all === true) selection = { all: true };
  else if (testIds.length > 0) selection = { test_ids: [...testIds] };
  else if (context.interactive) selection = await promptForSelection(context);
  else {
    throw new AttestCliError('cli_missing_input', 'Eval run selection is missing.', {
      path: '<test-id>|--all',
      hint: 'Pass one or more test ids, --all, or a complete --from-json request.',
    });
  }

  return parseEvalRunRequest({
    schema: COMMAND_REQUEST_SCHEMA_ID,
    command: 'eval.run',
    ...selection,
    ...(fields.caseIds === undefined ? {} : { case_ids: [...fields.caseIds] }),
    ...(fields.tags === undefined ? {} : { tags: [...fields.tags] }),
    ...(fields.folders === undefined ? {} : { folders: [...fields.folders] }),
    ...(fields.datasetIds === undefined ? {} : { dataset_ids: [...fields.datasetIds] }),
    ...(fields.sample === undefined
      ? {}
      : {
          sample: {
            count: Number(fields.sample),
            ...(fields.seed === undefined ? {} : { seed: fields.seed }),
          },
        }),
    ...(fields.concurrency === undefined ? {} : { concurrency: Number(fields.concurrency) }),
    ...(fields.timeout === undefined ? {} : { timeout_ms: parseDuration(fields.timeout) }),
    ...(fields.baseline === undefined ? {} : { baseline_run_id: fields.baseline }),
    ...(fields.junit === undefined ? {} : { junit_path: fields.junit }),
    output,
    ...(fields.watch === undefined ? {} : { watch: fields.watch }),
  });
};

/** Turns cancellation flags into one cancel request. */
const createEvalCancelRequest = (fields: EvalCancelRequestFields): EvalCancelRequest => {
  const runId = fields.runId?.trim();
  if (runId === undefined || runId.length === 0) {
    throw new AttestCliError('cli_missing_input', 'Eval cancellation requires a run id.', {
      path: '<run-id>',
      hint: 'Pass the immutable eval run id or a complete --from-json request.',
    });
  }
  return parseEvalCancelRequest({
    schema: COMMAND_REQUEST_SCHEMA_ID,
    command: 'eval.cancel',
    run_id: runId,
    output: fields.output ?? 'human',
  });
};

export {
  assertNoCancelFlags,
  assertNoRunFlags,
  createEvalCancelRequest,
  createEvalRunRequest,
  issueDiagnostics,
  parseEvalCancelRequest,
  parseEvalRunRequest,
  requestedOutput,
  type EvalCancelRequestFields,
  type EvalRunRequestFields,
};
