import { describe, expect, it } from 'vitest';

import type { Trace } from '@attest/contracts';

import type { JudgeRequest } from '../judge-client.js';
import { buildJudgePrompt, judgeResponseSchema, summarizeTraceForJudge } from '../rubric-prompt.js';

const request: JudgeRequest = {
  model: 'anthropic/claude-sonnet-5',
  rubric: 'Score 1 only when the output exactly matches expected.\nKeep this line verbatim.',
  document: {
    input: { question: 'Capital of France?' },
    output: { answer: 'Paris' },
    expected: { answer: 'Paris' },
    traceSummary: 'llm answer ok (12ms)',
  },
};

/** Creates a trace with predictable durations while avoiding payload evidence. */
const createTrace = (spanCount: number): Trace => ({
  schema: 'attest.trace',
  trace_id: 'trace-1',
  spans: Array.from({ length: spanCount }, (_, index) => ({
    span_id: `span-${index}`,
    parent_span_id: null,
    name: `operation-${index}`,
    kind: index % 2 === 0 ? 'llm' : 'tool',
    start_time: '2026-08-06T00:00:00.000Z',
    end_time: '2026-08-06T00:00:00.010Z',
    status: { code: index % 3 === 0 ? 'error' : 'ok' },
    input: { secret: `input-${index}` },
    output: { secret: `output-${index}` },
  })),
});

describe('buildJudgePrompt', () => {
  it('is byte-deterministic and includes the rubric verbatim', () => {
    const first = buildJudgePrompt(request);
    const second = buildJudgePrompt(structuredClone(request));

    expect(first).toEqual(second);
    expect(first.system).toContain(request.rubric);
    expect(first.user).toContain('Input:\n```json');
    expect(first.user).toContain('Output:\n```json');
    expect(first.user).toContain('Expected:\n```json');
    expect(first.user).toContain('Trace summary:\n```text');
  });

  it('uses valid JSON null blocks for absent optional document fields', () => {
    const prompt = buildJudgePrompt({
      ...request,
      document: { input: {}, output: undefined, expected: undefined, traceSummary: undefined },
    });

    expect(prompt.user.match(/```json\nnull\n```/g)).toHaveLength(2);
    expect(prompt.user).not.toContain('Trace summary:');
  });
});

describe('summarizeTraceForJudge', () => {
  it('returns no summary when a trace is absent or empty', () => {
    expect(summarizeTraceForJudge(null)).toBeUndefined();
    expect(summarizeTraceForJudge(createTrace(0))).toBeUndefined();
  });

  it('caps output at 50 shape-only span lines', () => {
    const summary = summarizeTraceForJudge(createTrace(55));
    const lines = summary?.split('\n') ?? [];

    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe('llm operation-0 error (10ms)');
    expect(lines[49]).toBe('tool operation-49 ok (10ms)');
    expect(summary).not.toContain('secret');
    expect(summary).not.toContain('operation-50');
  });
});

describe('judgeResponseSchema', () => {
  it('accepts finite scores and rationale text', () => {
    expect(
      judgeResponseSchema.safeParse({ score: 0.75, rationale: 'Mostly correct.' }).success,
    ).toBe(true);
  });

  it.each([
    { score: Number.NaN, rationale: 'not finite' },
    { score: 1 },
    { score: 1, rationale: 7 },
    { score: 1, rationale: 'ok', extra: true },
  ])('rejects malformed response %#', (candidate) => {
    expect(judgeResponseSchema.safeParse(candidate).success).toBe(false);
  });
});
