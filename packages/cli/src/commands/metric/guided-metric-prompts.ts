import type { MetricPresetId } from '@attest/contracts';

import type { CommandContext } from '../shared/command-context.js';
import { requiredInput } from '../shared/required-input.js';
import type { MetricAddOptions } from './register-metric-add-command.js';

/** One guided question: when to ask it and how its answer changes the options. */
type GuidedPrompt = {
  apply: (options: MetricAddOptions, answer: string) => MetricAddOptions;
  /** Answer used for an empty reply; without one an empty reply is missing input. */
  fallback?: string;
  needed: (options: MetricAddOptions) => boolean;
  path: string;
  question: (options: MetricAddOptions) => string;
};

const always = (): boolean => true;

const preview = (evidence: string, operator: string): string =>
  `Assertion preview: evidence=${evidence}; operator=${operator}.\n`;

/** Operators that need one more value as soon as they are chosen. */
const OPERATOR_PROMPTS: Partial<Record<string, GuidedPrompt>> = {
  regex: {
    path: '--pattern',
    question: (options) => `${preview(options.path ?? '', 'regex')}Regular expression: `,
    needed: always,
    apply: (options, pattern) => ({ ...options, pattern }),
  },
  lt: {
    path: '--lt',
    question: (options) => `${preview(options.path ?? '', 'lt')}Numeric threshold: `,
    needed: always,
    apply: (options, lt) => ({ ...options, lt }),
  },
  lte: {
    path: '--lte',
    question: (options) => `${preview(options.path ?? '', 'lte')}Numeric threshold: `,
    needed: always,
    apply: (options, lte) => ({ ...options, lte }),
  },
  gt: {
    path: '--gt',
    question: (options) => `${preview(options.path ?? '', 'gt')}Numeric threshold: `,
    needed: always,
    apply: (options, gt) => ({ ...options, gt }),
  },
  gte: {
    path: '--gte',
    question: (options) => `${preview(options.path ?? '', 'gte')}Numeric threshold: `,
    needed: always,
    apply: (options, gte) => ({ ...options, gte }),
  },
};

/** The values each preset still needs once it is chosen, asked in order. */
const PRESET_PROMPTS: Partial<Record<MetricPresetId, readonly GuidedPrompt[]>> = {
  'output-equals': [
    {
      path: '--value',
      question: (options) => `${preview(options.path ?? '$.output', 'equals')}JSON value: `,
      needed: (options) => options.value === undefined,
      apply: (options, value) => ({ ...options, value }),
    },
  ],
  'output-contains': [
    {
      path: '--value',
      question: (options) => `${preview(options.path ?? '$.output', 'contains')}JSON value: `,
      needed: (options) => options.value === undefined,
      apply: (options, value) => ({ ...options, value }),
    },
  ],
  'output-schema': [
    {
      path: '--json-schema',
      question: (options) => `${preview(options.path ?? '$.output', 'json-schema')}JSON Schema: `,
      needed: (options) => options.jsonSchema === undefined && options.jsonSchemaFile === undefined,
      apply: (options, jsonSchema) => ({ ...options, jsonSchema }),
    },
  ],
  'judge-rubric': [
    {
      path: '--model',
      question: () => 'Provider/model: ',
      needed: (options) => !options.model?.trim(),
      apply: (options, model) => ({ ...options, model }),
    },
    {
      path: '--rubric',
      question: () => 'Rubric: ',
      needed: (options) => options.rubric === undefined && options.rubricFile === undefined,
      apply: (options, rubric) => ({ ...options, rubric }),
    },
  ],
  command: [
    {
      path: '--argv-json',
      question: () => 'Metric argv JSON: ',
      needed: (options) => !options.argvJson?.trim(),
      apply: (options, argvJson) => ({ ...options, argvJson }),
    },
  ],
  http: [
    {
      path: '--url',
      question: () => 'Metric URL: ',
      needed: (options) => !options.url?.trim(),
      apply: (options, url) => ({ ...options, url }),
    },
  ],
  'tool-called': [
    {
      path: '--tool',
      question: () => `${preview('trace', 'tool-called')}Tool name: `,
      needed: (options) => !options.tool?.trim(),
      apply: (options, tool) => ({ ...options, tool }),
    },
  ],
  'tool-order': [
    {
      path: '--order',
      question: () => `${preview('trace', 'tool-order')}Tool names in order (comma-separated): `,
      needed: (options) => (options.order?.length ?? 0) === 0,
      apply: (options, order) => ({
        ...options,
        order: order
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      }),
    },
  ],
  'trace-span': [
    {
      path: '--span-kind',
      question: () => `${preview('trace', 'span')}Span kind [other]: `,
      fallback: 'other',
      needed: (options) =>
        options.spanKind === undefined &&
        options.spanName === undefined &&
        options.spanStatus === undefined &&
        options.attribute === undefined,
      apply: (options, spanKind) => ({ ...options, spanKind }),
    },
  ],
};

/** Asks one guided question and applies its answer. */
const askGuidedPrompt = async (
  step: GuidedPrompt,
  options: MetricAddOptions,
  context: CommandContext,
): Promise<MetricAddOptions> => {
  const question = step.question(options);
  const answer =
    step.fallback === undefined
      ? await requiredInput(
          undefined,
          { path: step.path, question },
          { interactive: true, prompt: context.interaction.prompt },
        )
      : (await context.interaction.prompt(question)).trim() || step.fallback;
  return step.apply(options, answer);
};

export { OPERATOR_PROMPTS, PRESET_PROMPTS, askGuidedPrompt };
