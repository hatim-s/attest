import * as Effect from 'effect/Effect';
import {
  parseWithSchema,
  COMMAND_REQUEST_SCHEMA_ID,
  isJsonObject,
  evalCancelRequestSchema,
  evalOutputModeSchema,
  evalRunRequestSchema,
  type EvalCancelRequest,
  type EvalOutputMode,
  type EvalRunRequest,
  type JsonValue,
  type SchemaDiagnostic,
} from '@attest/contracts';
import { parseDuration } from '@attest/local/agent';
import type { Command } from 'commander';

import { AttestCliError } from '../../errors/cli-error.js';
import { authoredFieldPresence } from '../shared/cli-options.js';
import { assertNoRequestOverlap } from '../shared/command-request.js';
import { promptWithSignal, type PromptContext } from '../shared/required-input.js';

type EvalRunRequestFields = Partial<Pick<EvalRunRequest, 'tags' | 'folders' | 'output'>> & {
  all?: Extract<EvalRunRequest, { all: true }>['all'];
  baseline?: EvalRunRequest['baseline_run_id'];
  caseIds?: EvalRunRequest['case_ids'];
  concurrency?: string;
  datasetIds?: EvalRunRequest['dataset_ids'];
  junit?: EvalRunRequest['junit_path'];
  sample?: string;
  seed?: string;
  testIds?: Extract<EvalRunRequest, { test_ids: readonly string[] }>['test_ids'];
  timeout?: string;
  watch?: Extract<EvalRunRequest, { output: 'human' }>['watch'];
};

/** Flags remain a draft until numeric bounds and selection validate together. */
type EvalRunRequestDraft = Pick<EvalRunRequest, 'schema' | 'command' | 'output'> &
  Partial<Omit<EvalRunRequest, 'schema' | 'command' | 'output'>> & {
    all?: Extract<EvalRunRequest, { all: true }>['all'];
    test_ids?: Extract<EvalRunRequest, { test_ids: readonly string[] }>['test_ids'];
    watch?: Extract<EvalRunRequest, { output: 'human' }>['watch'];
  };

type EvalCancelRequestFields = Partial<Pick<EvalCancelRequest, 'output'>> & {
  runId?: EvalCancelRequest['run_id'];
};

/** Lists schema issues with JSON Pointer-style paths for the error `details`. */
const issueDiagnostics = (issues: readonly SchemaDiagnostic[]): JsonValue =>
  issues.map(({ message, path }) => ({ message, path: `/${path.map(String).join('/')}` }));

/** Reads the `output` a request document asks for, even when the rest of it is invalid. */
const requestedOutput = (document: JsonValue): EvalOutputMode | undefined => {
  if (!isJsonObject(document)) {
    return undefined;
  }

  const parsed = parseWithSchema(evalOutputModeSchema, document.output);

  return parsed.ok ? parsed.value : undefined;
};

/** Validates one eval run request from flags or `--from-json` through the published schema. */
// BOUNDARY: CLI drafts and decoded JSON documents are checked together by the native request schema.
const parseEvalRunRequest = (value: unknown): EvalRunRequest => {
  const parsed = parseWithSchema(evalRunRequestSchema, value);

  if (!parsed.ok) {
    throw new AttestCliError('cli_usage', 'The eval run request does not match its schema.', {
      hint: 'Run `attest help eval run --output json` and repair every diagnostic.',
      details: { diagnostics: issueDiagnostics(parsed.error.issues) },
    });
  }

  return parsed.value;
};

/** Validates one eval cancel request from flags or `--from-json` through the published schema. */
const parseEvalCancelRequest = (value: JsonValue): EvalCancelRequest => {
  const parsed = parseWithSchema(evalCancelRequestSchema, value);

  if (!parsed.ok) {
    throw new AttestCliError('cli_usage', 'The eval cancel request does not match its schema.', {
      hint: 'Run `attest help eval cancel --output json` and repair every diagnostic.',
      details: { diagnostics: issueDiagnostics(parsed.error.issues) },
    });
  }

  return parsed.value;
};

/** Eval request documents own output too, including a root-position output option. */
const assertNoEvalFlags = (fromJson: string | undefined, command: Command): void => {
  const fields = authoredFieldPresence(
    command,
    new Set(['from-json', 'non-interactive', 'project']),
  );

  const optionNames = new Set(command.options.map((option) => option.name()));

  assertNoRequestOverlap(
    { fromJson },
    new Set([...fields].map((name) => (optionNames.has(name) ? `--${name}` : `<${name}>`))),
  );
};

/** Asks which tests to run; an empty answer or `all` selects every test. */
const promptForSelection = Effect.fn('promptForSelection')(function* (
  context: PromptContext,
): Effect.fn.Return<{ all: true } | { test_ids: readonly string[] }, Error> {
  const question = 'Test ids (space-separated) or all [all]: ';
  const answer = (yield* promptWithSignal(context.prompt, question, context.signal)).trim();

  if (answer.length === 0 || answer.toLowerCase() === 'all') return { all: true };

  return { test_ids: answer.split(/[\s,]+/u).filter((value) => value.length > 0) };
});

/** Turns run flags, or the selection wizard when no tests were named, into one run request. */
const createEvalRunRequest = Effect.fn('createEvalRunRequest')(function* (
  fields: EvalRunRequestFields,
  context: PromptContext,
): Effect.fn.Return<EvalRunRequest, Error> {
  const testIds = fields.testIds ?? [];

  if (fields.all === true && testIds.length > 0) {
    return yield* new AttestCliError('cli_usage', '`--all` conflicts with explicit test ids.', {
      path: '--all',
      hint: 'Pass either --all or one or more test ids.',
      details: { conflicting_fields: ['--all', '<test-id>'] },
    });
  }

  if (fields.seed !== undefined && fields.sample === undefined) {
    return yield* new AttestCliError('cli_usage', '`--seed` requires `--sample`.');
  }

  const output = fields.output ?? 'human';

  if (fields.watch === true && output !== 'human') {
    return yield* new AttestCliError('cli_usage', '`--watch` requires human output.', {
      path: '--watch',
      hint: 'Remove --watch or use --output human.',
      details: { conflicting_fields: ['--output', '--watch'] },
    });
  }

  let selection: { all: true } | { test_ids: readonly string[] };

  if (fields.all === true) selection = { all: true };
  else if (testIds.length > 0) selection = { test_ids: [...testIds] };
  else if (context.interactive) selection = yield* promptForSelection(context);
  else {
    return yield* new AttestCliError('cli_missing_input', 'Eval run selection is missing.', {
      path: '<test-id>|--all',
      hint: 'Pass one or more test ids, --all, or a complete --from-json request.',
    });
  }

  let request: EvalRunRequestDraft = {
    schema: COMMAND_REQUEST_SCHEMA_ID,
    command: 'eval.run',
    ...selection,
    output,
  };

  if (fields.caseIds !== undefined) request = { ...request, case_ids: [...fields.caseIds] };

  if (fields.tags !== undefined) request = { ...request, tags: [...fields.tags] };

  if (fields.folders !== undefined) request = { ...request, folders: [...fields.folders] };

  if (fields.datasetIds !== undefined)
    request = { ...request, dataset_ids: [...fields.datasetIds] };

  if (fields.sample !== undefined) {
    let sample: NonNullable<EvalRunRequest['sample']> = { count: Number(fields.sample) };

    if (fields.seed !== undefined) sample = { ...sample, seed: fields.seed };
    request = { ...request, sample: sample };
  }

  if (fields.concurrency !== undefined)
    request = { ...request, concurrency: Number(fields.concurrency) };

  if (fields.timeout !== undefined)
    request = {
      ...request,
      timeout_ms: yield* Effect.try({
        try: () => parseDuration(fields.timeout ?? ''),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error('Duration parsing failed.', { cause }),
      }),
    };

  if (fields.baseline !== undefined) request = { ...request, baseline_run_id: fields.baseline };

  if (fields.junit !== undefined) request = { ...request, junit_path: fields.junit };

  if (fields.watch !== undefined) request.watch = fields.watch;

  return yield* Effect.try({
    try: () => parseEvalRunRequest(request),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error('Eval request parsing failed.', { cause }),
  });
});

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
  assertNoEvalFlags,
  createEvalCancelRequest,
  createEvalRunRequest,
  issueDiagnostics,
  parseEvalCancelRequest,
  parseEvalRunRequest,
  requestedOutput,
  type EvalCancelRequestFields,
  type EvalRunRequestFields,
};
