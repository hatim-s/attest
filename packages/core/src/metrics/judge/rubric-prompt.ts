import { z } from 'zod';

import type { JsonValue, Trace } from '@attest/contracts';

import type { JudgeRequest } from './judge-client.js';

const MAXIMUM_TRACE_SPANS = 50;

/** Constrains the provider response while allowing every finite score supported by metric contract §3. */
const judgeResponseSchema: z.ZodType<{ score: number; rationale: string }> = z.strictObject({
  score: z.number().finite(),
  rationale: z.string(),
});

/** Serializes absent optional evidence as JSON null so every labeled prompt block remains valid JSON. */
const formatJsonBlock = (value: JsonValue | undefined): string =>
  JSON.stringify(value ?? null, undefined, 2);

/**
 * Assembles the deterministic, case-local judge prompt required by metric contract §3.
 * The rubric is included verbatim and no clock or provider state can affect the prompt bytes.
 */
const buildJudgePrompt = (request: JudgeRequest): { system: string; user: string } => {
  const system = [
    'You are an impartial evaluator scoring one agent result.',
    'Apply the following rubric exactly as written:',
    request.rubric,
    'Score the result according to the rubric and return only {score, rationale}.',
  ].join('\n\n');
  const sections = [
    `Input:\n\`\`\`json\n${formatJsonBlock(request.document.input)}\n\`\`\``,
    `Output:\n\`\`\`json\n${formatJsonBlock(request.document.output)}\n\`\`\``,
    `Expected:\n\`\`\`json\n${formatJsonBlock(request.document.expected)}\n\`\`\``,
  ];

  if (request.document.traceSummary !== undefined) {
    sections.push(`Trace summary:\n\`\`\`text\n${request.document.traceSummary}\n\`\`\``);
  }

  return { system, user: sections.join('\n\n') };
};

/**
 * Reduces a trace to at most 50 shape-only span lines for metric contract §3.
 * Inputs, outputs, attributes, and events stay out of judge prompts to keep payloads small and case-local.
 */
const summarizeTraceForJudge = (trace: Trace | null): string | undefined => {
  if (trace === null || trace.spans.length === 0) {
    return undefined;
  }

  return trace.spans
    .slice(0, MAXIMUM_TRACE_SPANS)
    .map((span) => {
      const durationMs = Date.parse(span.end_time) - Date.parse(span.start_time);
      // A span name can contain newlines; collapse them so one span always occupies one summary line.
      const name = span.name.replace(/\s+/g, ' ').trim();
      return `${span.kind} ${name} ${span.status.code} (${durationMs}ms)`;
    })
    .join('\n');
};

export { buildJudgePrompt, judgeResponseSchema, summarizeTraceForJudge };
