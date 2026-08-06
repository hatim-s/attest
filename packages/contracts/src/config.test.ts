import { describe, expect, it } from 'vitest';

import { configSchema } from './config.js';
import { parseConfig } from './parse.js';
import { CONFIG_VERSION } from './versions.js';

const configFixture = {
  config_version: CONFIG_VERSION,
  project: 'support-agent',
  agent: {
    type: 'cli',
    command: ['bun', 'run', 'src/agent.ts'],
    env: ['ANTHROPIC_API_KEY'],
    timeout_ms: 60_000,
    retries: 1,
  },
  suites: [
    {
      name: 'smoke',
      metrics: ['answer-correctness'],
      cases: [{ id: 'greeting', input: { question: 'Capital of France?' } }],
    },
  ],
  metrics: [
    {
      name: 'answer-correctness',
      type: 'judge',
      model: 'anthropic/claude-sonnet-5',
      rubric: 'Score factual consistency.',
    },
  ],
  run: { concurrency: 4, output_cap_bytes: 10_485_760 },
};

describe('configSchema', () => {
  it('accepts the documented v1 configuration shape', () => {
    expect(configSchema.safeParse(configFixture).success).toBe(true);
  });

  it('rejects unknown fields with their precise path', () => {
    const result = parseConfig({ ...configFixture, unexpected: true });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error[0]?.path).toBe('unexpected');
  });

  it('rejects a suite containing both inline cases and a dataset', () => {
    const config = structuredClone(configFixture) as Omit<
      typeof configFixture,
      'suites' | 'metrics'
    > & {
      suites: Array<{
        name: string;
        metrics: string[];
        cases: Array<{ id: string; input: unknown; metrics?: string[] }>;
      }>;
      metrics: Array<Record<string, unknown>>;
    };
    Object.assign(config.suites[0]!, { dataset: './cases.jsonl' });

    const result = parseConfig(config);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error).toContainEqual({
      path: 'suites.0.cases',
      message: 'exactly one of cases or dataset must be present',
    });
  });

  it('rejects an empty CLI command', () => {
    const config = structuredClone(configFixture) as Omit<
      typeof configFixture,
      'suites' | 'metrics'
    > & {
      suites: Array<{
        name: string;
        metrics: string[];
        cases: Array<{ id: string; input: unknown; metrics?: string[] }>;
      }>;
      metrics: Array<Record<string, unknown>>;
    };
    config.agent.command = [];

    const result = configSchema.safeParse(config);

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error.issues[0]?.path).toEqual(['agent', 'command']);
  });

  it('rejects duplicate names, case ids, and dangling metric references', () => {
    const config = structuredClone(configFixture) as Omit<
      typeof configFixture,
      'suites' | 'metrics'
    > & {
      suites: Array<{
        name: string;
        metrics: string[];
        cases: Array<{ id: string; input: unknown; metrics?: string[] }>;
      }>;
      metrics: Array<Record<string, unknown>>;
    };
    config.suites.push({
      name: 'smoke',
      metrics: ['missing-suite-metric'],
      cases: [
        { id: 'greeting', input: { question: 'duplicate' }, metrics: ['missing-case-metric'] },
        { id: 'greeting', input: { question: 'duplicate' } },
      ],
    });
    config.metrics.push({ ...config.metrics[0]! });

    const result = configSchema.safeParse(config);

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        ['metrics', 1, 'name'],
        ['suites', 1, 'name'],
        ['suites', 1, 'metrics', 0],
        ['suites', 1, 'cases', 1, 'id'],
        ['suites', 1, 'cases', 0, 'metrics', 0],
      ]),
    );
    expect(result.error.issues).toHaveLength(5);
  });
});
