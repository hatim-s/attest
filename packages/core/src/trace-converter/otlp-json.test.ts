import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { convertOtlpJson, nanosecondsToTimestamp, selectConvertedTrace } from './otlp-json.js';

/** Loads one checked-in sanitized framework export as opaque converter input. */
const loadFixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;

describe('convertOtlpJson', () => {
  it('normalizes a Vercel AI SDK export into agent, llm, and tool spans', async () => {
    const [trace] = convertOtlpJson(await loadFixture('vercel-ai-sdk.otlp.json'));

    expect(trace?.trace_id).toBe('5b8efff798038103d269b633813fc60c');
    expect(trace?.spans.map(({ kind }) => kind)).toEqual(['agent', 'llm', 'tool']);
    expect(trace?.spans[1]).toMatchObject({
      attributes: {
        'gen_ai.request.model': 'gpt-5-mini',
        'gen_ai.usage.input_tokens': 34,
        'otel.scope.name': 'ai',
        'service.name': 'vercel-ai-example',
      },
      events: [{ name: 'ai.stream.firstChunk' }],
    });
    expect(trace?.spans[2]).toMatchObject({
      attributes: {
        'gen_ai.tool.call.arguments': '{"city":"Paris"}',
        'gen_ai.tool.name': 'weather',
      },
      input: { city: 'Paris' },
      output: { temperature_c: 24 },
    });
  });

  it('normalizes a LangChain/LangSmith export and its framework aliases', async () => {
    const [trace] = convertOtlpJson(await loadFixture('langchain-langsmith.otlp.json'));

    expect(trace?.spans.map(({ kind }) => kind)).toEqual(['agent', 'llm', 'tool']);
    expect(trace?.spans[0]?.input).toEqual({ question: 'Capital of France?' });
    expect(trace?.spans[2]).toMatchObject({
      attributes: {
        'gen_ai.tool.call.arguments': '{"query":"capital of France"}',
        'gen_ai.tool.name': 'search',
      },
      output: { answer: 'Paris' },
    });
  });

  it('selects explicitly from multi-trace exports and rejects ambiguity', async () => {
    const first = (await loadFixture('vercel-ai-sdk.otlp.json')) as {
      resourceSpans: unknown[];
    };
    const second = (await loadFixture('langchain-langsmith.otlp.json')) as {
      resourceSpans: unknown[];
    };
    const traces = convertOtlpJson({
      resourceSpans: [...first.resourceSpans, ...second.resourceSpans],
    });

    expect(() => selectConvertedTrace(traces)).toThrowError(/contains 2 traces/);
    expect(
      selectConvertedTrace(traces, { traceId: '8A7B6C5D4E3F20112233445566778899' }).trace_id,
    ).toBe('8a7b6c5d4e3f20112233445566778899');
  });

  it('rejects malformed IDs and preserves timestamp ordering', () => {
    expect(nanosecondsToTimestamp('1786059000100000000', 'time')).toBe('2026-08-06T23:30:00.100Z');
    expect(() =>
      convertOtlpJson({
        resourceSpans: [
          { scopeSpans: [{ spans: [{ traceId: 'bad', spanId: '1000000000000001' }] }] },
        ],
      }),
    ).toThrowError(/traceId and 16-character spanId/);
  });
});
