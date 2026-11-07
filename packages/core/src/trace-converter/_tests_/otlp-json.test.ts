import { stripStruct } from '@attest/contracts';
import { parseWithSchemaSync } from '@attest/contracts';
import * as Schema from 'effect/Schema';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { convertOtlpJson, selectConvertedTrace } from '../otlp-json.js';

interface OtlpFixture {
  resourceSpans: readonly unknown[];
}

/** Loads one checked-in sanitized framework export as converter input. */
const loadFixture = async (name: string): Promise<OtlpFixture> =>
  parseWithSchemaSync(
    stripStruct({ resourceSpans: Schema.Array(Schema.Unknown) }),
    JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')),
  );

describe('convertOtlpJson', () => {
  it.each([
    {},
    { parentSpanId: undefined },
    { attributes: null },
    { attributes: {} },
    { events: [{ name: 'event', timeUnixNano: '1000000000', attributes: null }] },
    { events: [{ name: 'event', timeUnixNano: '1000000000', attributes: {} }] },
  ])('accepts root spans and degrades malformed attributes: %j', (extra) => {
    const [trace] = convertOtlpJson({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'a'.repeat(32),
                  spanId: 'b'.repeat(16),
                  name: 'root',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                  ...extra,
                },
              ],
            },
          ],
        },
      ],
    });

    expect(trace?.spans).toHaveLength(1);
    expect(trace?.spans[0]?.parent_span_id).toBeNull();
    expect(trace?.spans[0]?.attributes).toBeUndefined();

    if ('events' in extra) expect(trace?.spans[0]?.events?.[0]?.attributes).toBeUndefined();
  });

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
    const first = await loadFixture('vercel-ai-sdk.otlp.json');
    const second = await loadFixture('langchain-langsmith.otlp.json');

    const traces = convertOtlpJson({
      resourceSpans: [...first.resourceSpans, ...second.resourceSpans],
    });

    expect(() => selectConvertedTrace(traces)).toThrowError(/contains 2 traces/);
    expect(selectConvertedTrace(traces, '8A7B6C5D4E3F20112233445566778899').trace_id).toBe(
      '8a7b6c5d4e3f20112233445566778899',
    );
  });

  it('rejects malformed trace ids', () => {
    expect(() =>
      convertOtlpJson({
        resourceSpans: [
          { scopeSpans: [{ spans: [{ traceId: 'bad', spanId: '1000000000000001' }] }] },
        ],
      }),
    ).toThrowError(/spans\[0\]\.traceId: must be a 32-character hex string/);
  });
});

it.each(['invalid', '-1', '1.5', '9'.repeat(60)])(
  'rejects malformed OTLP timestamp %s with authored diagnostics',
  async (timestamp) => {
    const fixture = await loadFixture('vercel-ai-sdk.otlp.json');

    // Keep vendor fields and replace only the timestamp in an existing valid span.
    const text = JSON.stringify(fixture).replace(
      /"startTimeUnixNano":"\d+"/,
      `"startTimeUnixNano":"${timestamp}"`,
    );

    expect(text).not.toBe(JSON.stringify(fixture));
    expect(() => convertOtlpJson(JSON.parse(text))).toThrow(
      /must be an unsigned nanosecond timestamp|is outside the Date range/,
    );
  },
);
