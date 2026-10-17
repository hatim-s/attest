type BuildJudgePromptResult = { system: string; user: string };

import { z } from 'zod';

import type { JsonValue, Trace } from '@attest/contracts';
import { canonicalStringify } from '@attest/core';

import type { JudgeRequest } from './judge-client.js';

const MAXIMUM_TRACE_SPANS = 50;

/**
 * Versions judge prompt framing and structured-output policy for cache invalidation.
 * Bump whenever either changes so stale verdicts cannot replay.
 */
const JUDGE_PROMPT_VERSION = 1;

const MAXIMUM_STRUCTURED_OUTPUT_ATTEMPTS = 2;

/** Records the generation policy shared by cache keys and persisted judge requests. */
const JUDGE_REQUEST_PARAMS = {
  stream: false,
  structuredOutput: true,
  maximumAttempts: MAXIMUM_STRUCTURED_OUTPUT_ATTEMPTS,
} as const satisfies Record<string, JsonValue>;

/** Constrains the provider response while allowing every finite score. */
const judgeResponseSchema = z.strictObject({
  score: z.number().finite(),
  rationale: z.string(),
});

/** Renders one prompt block with sorted keys so logically equal evidence produces identical bytes. */
const formatJsonBlock = (value: JsonValue | undefined): string =>
  JSON.stringify(JSON.parse(canonicalStringify(value ?? null)), undefined, 2);

/**
 * Assembles the deterministic, case-local judge prompt.
 * The rubric is included verbatim and no clock or provider state can affect the prompt bytes.
 */
const buildJudgePrompt = (request: JudgeRequest): BuildJudgePromptResult => {
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
 * Reduces a trace to a bounded number of shape-only span lines.
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

export {
  buildJudgePrompt,
  JUDGE_PROMPT_VERSION,
  JUDGE_REQUEST_PARAMS,
  judgeResponseSchema,
  MAXIMUM_STRUCTURED_OUTPUT_ATTEMPTS,
  summarizeTraceForJudge,
};
