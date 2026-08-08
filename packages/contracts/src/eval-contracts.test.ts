import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import * as formatsModule from 'ajv-formats';
import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { cliEventSchema, cliResultSchema } from './cli-protocol.js';
import { commandRequestSchema } from './command-request-v2.js';
import {
  evalCancelRequestSchema,
  evalCancelResultSchema,
  type EvalCancelRequest,
} from './eval-cancel-v1.js';
import {
  evalEventSchema,
  evalEventStreamSchema,
  evalFinalResultDataSchema,
  type EvalEventStream,
} from './eval-event-v1.js';
import {
  evalRunRequestSchema,
  evalRunSchema,
  type EvalRun,
  type EvalRunRequest,
} from './eval-run-v1.js';
import { serializeContractSchema } from './json-schema.js';

const fixturesDirectory = resolve(import.meta.dirname, 'fixtures');

/** Reads one committed JSON golden without weakening its unknown boundary. */
const readJsonFixture = async (relativePath: string): Promise<unknown> =>
  JSON.parse(await readFile(resolve(fixturesDirectory, relativePath), 'utf8')) as unknown;

/** Reads a JSONL golden while preserving the line order asserted by the event-stream contract. */
const readJsonlFixture = async (relativePath: string): Promise<unknown[]> =>
  (await readFile(resolve(fixturesDirectory, relativePath), 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);

/** Compiles a generated Draft 2020-12 contract for runtime/generator compatibility checks. */
const compileGeneratedSchema = (fileName: string) => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  formatsModule.default.default(ajv);
  ajv.addFormat('ulid', /^[0-9A-HJKMNP-TV-Z]{26}$/u);
  return ajv.compile(JSON.parse(serializeContractSchema(fileName)) as AnySchema);
};

const structuredTestRequest = {
  schema: 'attest.command-request/v2',
  command: 'eval.run',
  test_ids: ['refund'],
  case_ids: ['refund-basic'],
  tags: ['smoke'],
  concurrency: 2,
  timeout_ms: 60_000,
  baseline_run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAA',
  junit_path: 'artifacts/refund.xml',
  output: 'jsonl',
} as const satisfies EvalRunRequest;

const failedResult = {
  schema: 'attest.cli-result/v1',
  ok: false,
  command: 'eval.run',
  error: {
    code: 'run_failed',
    message: 'Evaluation could not complete.',
    retryable: true,
  },
} as const;

describe('eval run request contract', () => {
  it('accepts exact test/case/tag selection and every execution/output field', () => {
    expect(evalRunRequestSchema.safeParse(structuredTestRequest).success).toBe(true);
    expect(commandRequestSchema.safeParse(structuredTestRequest).success).toBe(true);
    expectTypeOf(structuredTestRequest).toMatchTypeOf<EvalRunRequest>();
  });

  it('accepts all-selection and human watch while excluding watch from machine output', () => {
    expect(
      evalRunRequestSchema.safeParse({
        schema: 'attest.command-request/v2',
        command: 'eval.run',
        all: true,
        output: 'human',
        watch: true,
      }).success,
    ).toBe(true);
    expect(
      evalRunRequestSchema.safeParse({
        schema: 'attest.command-request/v2',
        command: 'eval.run',
        all: true,
        output: 'json',
        watch: true,
      }).success,
    ).toBe(false);
  });

  it('rejects missing or ambiguous selection, v1 discovery fields, and execution aliases', () => {
    expect(
      evalRunRequestSchema.safeParse({
        schema: 'attest.command-request/v2',
        command: 'eval.run',
        output: 'json',
      }).success,
    ).toBe(false);
    expect(
      evalRunRequestSchema.safeParse({
        ...structuredTestRequest,
        all: true,
      }).success,
    ).toBe(false);
    expect(
      evalRunRequestSchema.safeParse({
        ...structuredTestRequest,
        config_path: 'attest.config.ts',
        suites: ['legacy-suite'],
      }).success,
    ).toBe(false);
    expect(
      commandRequestSchema.safeParse({ ...structuredTestRequest, command: 'run' }).success,
    ).toBe(false);
    expect(
      commandRequestSchema.safeParse({ ...structuredTestRequest, command: 'eval.add' }).success,
    ).toBe(false);
  });

  it('keeps the committed request golden compatible with runtime and generated schemas', async () => {
    const request = await readJsonFixture('eval-run/request.json');

    expect(evalRunRequestSchema.safeParse(request).success).toBe(true);
    expect(compileGeneratedSchema('eval-run-request.v2.json')(request)).toBe(true);
    expect(compileGeneratedSchema('command-request.v2.json')(request)).toBe(true);
  });
});

describe('immutable eval run metadata contract', () => {
  it('freezes resource hashes, selection order, snapshot hash, and effective command', async () => {
    const fixture = await readJsonFixture('eval-run/eval-run.json');
    const parsed = evalRunSchema.parse(fixture);

    expect(parsed.snapshot.selected_cases.map(({ configured_index }) => configured_index)).toEqual([
      0, 1,
    ]);
    expect(parsed.effective_command.command_path).toEqual(['eval', 'run']);
    expect(parsed.effective_command.resolved).toMatchObject({
      concurrency: 2,
      timeout_ms: 60_000,
      output: 'jsonl',
      watch: false,
    });
    expect(compileGeneratedSchema('eval-run.v1.json')(fixture)).toBe(true);
    expectTypeOf(parsed).toMatchTypeOf<EvalRun>();
  });

  it('rejects top-level run spelling and mutable or unknown snapshot metadata', async () => {
    const fixture = (await readJsonFixture('eval-run/eval-run.json')) as Record<string, unknown>;
    const run = evalRunSchema.parse(fixture);

    expect(
      evalRunSchema.safeParse({
        ...run,
        effective_command: { ...run.effective_command, command_path: ['run'] },
      }).success,
    ).toBe(false);
    expect(evalRunSchema.safeParse({ ...run, status: 'running' }).success).toBe(false);
    expect(
      evalRunSchema.safeParse({
        ...run,
        snapshot: { ...run.snapshot, config_path: 'attest.config.ts' },
      }).success,
    ).toBe(false);
  });
});

describe('eval event compatibility and sequencing', () => {
  it('accepts actual completion order while retaining configured case indexes', async () => {
    const events = await readJsonlFixture('eval-run/events.jsonl');
    const stream = evalEventStreamSchema.parse(events);
    const completed = stream.filter((event) => event.event === 'case_completed');

    expect(completed.map(({ data }) => data.configured_index)).toEqual([1, 0]);
    expect(completed.map(({ data }) => data.completion_index)).toEqual([0, 1]);
    expect(stream.at(-1)?.event).toBe('result');
    expect(events.every((event) => cliEventSchema.safeParse(event).success)).toBe(true);
    const validateGeneratedEvent = compileGeneratedSchema('eval-event.v1.json');
    events.forEach((event) => expect(validateGeneratedEvent(event)).toBe(true));
    expectTypeOf(stream).toMatchTypeOf<EvalEventStream>();
  });

  it('rejects nondeterministic sequence, start-order drift, and a non-final result', async () => {
    const events = evalEventStreamSchema.parse(await readJsonlFixture('eval-run/events.jsonl'));
    const badSequence = events.map((event) => ({ ...event }));
    badSequence[3] = { ...badSequence[3]!, sequence: 9 };
    const badStartOrder = events.map((event) => ({ ...event }));
    const secondStart = badStartOrder[2];
    if (secondStart?.event !== 'case_started') throw new Error('Golden case-start event drifted.');
    badStartOrder[2] = { ...secondStart, data: { ...secondStart.data, configured_index: 0 } };

    expect(evalEventStreamSchema.safeParse(badSequence).success).toBe(false);
    expect(evalEventStreamSchema.safeParse(badStartOrder).success).toBe(false);
    expect(evalEventStreamSchema.safeParse(events.slice(0, -1)).success).toBe(false);
  });

  it('freezes the complete 0/1/2/3/4/130 exit-code matrix and shared final result envelope', async () => {
    const events = evalEventStreamSchema.parse(await readJsonlFixture('eval-run/events.jsonl'));
    const resultEvent = events.at(-1);
    if (resultEvent?.event !== 'result') throw new Error('Golden final result event drifted.');
    const failingSuccess = resultEvent.data.result;
    if (!failingSuccess.ok) throw new Error('Golden evaluated-failure result drifted.');
    const passingSuccess = {
      ...failingSuccess,
      result: { ...failingSuccess.result, verdict: 'pass' },
    };

    expect(
      evalFinalResultDataSchema.safeParse({ exit_code: 0, result: passingSuccess }).success,
    ).toBe(true);
    expect(
      evalFinalResultDataSchema.safeParse({ exit_code: 1, result: failingSuccess }).success,
    ).toBe(true);
    for (const exit_code of [1, 2, 3, 4, 130] as const) {
      const data = { exit_code, result: failedResult };
      expect(evalFinalResultDataSchema.safeParse(data).success).toBe(true);
      expect(
        evalEventStreamSchema.safeParse([
          {
            schema: 'attest.cli-event/v1',
            sequence: 0,
            time: '2026-08-08T10:00:00.000Z',
            event: 'result',
            data,
          },
        ]).success,
      ).toBe(true);
    }
    expect(
      evalFinalResultDataSchema.safeParse({ exit_code: 0, result: failedResult }).success,
    ).toBe(false);
    expect(cliResultSchema.safeParse(failingSuccess).success).toBe(true);
  });
});

describe('eval cancellation contract', () => {
  it('accepts strict request/result goldens through specialized and shared contracts', async () => {
    const request = await readJsonFixture('eval-cancel/request.json');
    const result = await readJsonFixture('eval-cancel/result.json');

    expect(evalCancelRequestSchema.safeParse(request).success).toBe(true);
    expect(commandRequestSchema.safeParse(request).success).toBe(true);
    expect(evalCancelResultSchema.safeParse(result).success).toBe(true);
    expect(cliResultSchema.safeParse(result).success).toBe(true);
    expect(compileGeneratedSchema('eval-cancel-request.v2.json')(request)).toBe(true);
    expect(compileGeneratedSchema('eval-cancel-result.v1.json')(result)).toBe(true);
    expectTypeOf(evalCancelRequestSchema.parse(request)).toMatchTypeOf<EvalCancelRequest>();
  });

  it('rejects the top-level run alias and unknown cancellation controls', () => {
    const request = {
      schema: 'attest.command-request/v2',
      command: 'eval.cancel',
      run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      output: 'json',
    };

    expect(evalCancelRequestSchema.safeParse({ ...request, command: 'run.cancel' }).success).toBe(
      false,
    );
    expect(evalCancelRequestSchema.safeParse({ ...request, force: true }).success).toBe(false);
    expect(evalEventSchema.safeParse({ event: 'cancel', data: request }).success).toBe(false);
  });
});
