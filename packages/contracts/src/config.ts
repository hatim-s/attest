import { z } from 'zod';

import { metricDefinitionSchema } from './metric.js';
import { CONFIG_VERSION } from './versions.js';

const commonAgentFields = {
  env: z.array(z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
  retries: z.number().int().nonnegative().optional(),
};

/** Encodes CLI and HTTP agent targets from docs/specs/config-format.md. */
const agentTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('cli'),
    command: z.array(z.string()).nonempty(),
    ...commonAgentFields,
  }),
  z.strictObject({
    type: z.literal('http'),
    url: z.url(),
    ...commonAgentFields,
  }),
]);

/** Represents a validated CLI or HTTP agent invocation target. */
type AgentTarget = z.infer<typeof agentTargetSchema>;

/** Encodes an inline or dataset case from docs/specs/config-format.md. */
const caseSchema = z.strictObject({
  id: z.string(),
  input: z.json(),
  expected: z.json().optional(),
  params: z.record(z.string(), z.json()).optional(),
  metrics: z.array(z.string()).optional(),
});

/** Represents a validated evaluation case before cross-reference resolution. */
type CaseDefinition = z.infer<typeof caseSchema>;

/** Encodes a config suite and its cases-or-dataset invariant from docs/specs/config-format.md. */
const suiteSchema = z
  .strictObject({
    name: z.string(),
    metrics: z.array(z.string()),
    cases: z.array(caseSchema).optional(),
    dataset: z.string().optional(),
  })
  .superRefine((suite, context) => {
    const hasCases = suite.cases !== undefined;
    const hasDataset = suite.dataset !== undefined;
    if (hasCases !== hasDataset) {
      return;
    }

    context.addIssue({
      code: 'custom',
      path: ['cases'],
      message: 'exactly one of cases or dataset must be present',
    });
  });

/** Represents a validated named suite with unresolved metric name references. */
type Suite = z.infer<typeof suiteSchema>;

/** Encodes runner limits and concurrency settings from docs/specs/config-format.md. */
const runSettingsSchema = z.strictObject({
  concurrency: z.number().int().positive().optional(),
  timeout_ms: z.number().int().positive().optional(),
  output_cap_bytes: z.number().int().positive().optional(),
});

/** Represents validated optional runner settings. */
type RunSettings = z.infer<typeof runSettingsSchema>;

/** Encodes the strict v1 document from docs/specs/config-format.md. */
const configSchema = z
  .strictObject({
    config_version: z.literal(CONFIG_VERSION),
    project: z.string().optional(),
    agent: agentTargetSchema,
    suites: z.array(suiteSchema).nonempty(),
    metrics: z.array(metricDefinitionSchema),
    run: runSettingsSchema.optional(),
  })
  .superRefine((config, context) => {
    const metricNames = new Set<string>();
    config.metrics.forEach((metric, metricIndex) => {
      if (metricNames.has(metric.name)) {
        context.addIssue({
          code: 'custom',
          path: ['metrics', metricIndex, 'name'],
          message: `duplicate metric definition name: ${metric.name}`,
        });
      }
      metricNames.add(metric.name);
    });

    const suiteNames = new Set<string>();
    config.suites.forEach((suite, suiteIndex) => {
      if (suiteNames.has(suite.name)) {
        context.addIssue({
          code: 'custom',
          path: ['suites', suiteIndex, 'name'],
          message: `duplicate suite name: ${suite.name}`,
        });
      }
      suiteNames.add(suite.name);

      suite.metrics.forEach((metricName, metricIndex) => {
        if (!metricNames.has(metricName)) {
          context.addIssue({
            code: 'custom',
            path: ['suites', suiteIndex, 'metrics', metricIndex],
            message: `metric is not defined: ${metricName}`,
          });
        }
      });

      const caseIds = new Set<string>();
      suite.cases?.forEach((evaluationCase, caseIndex) => {
        if (caseIds.has(evaluationCase.id)) {
          context.addIssue({
            code: 'custom',
            path: ['suites', suiteIndex, 'cases', caseIndex, 'id'],
            message: `duplicate case id: ${evaluationCase.id}`,
          });
        }
        caseIds.add(evaluationCase.id);

        evaluationCase.metrics?.forEach((metricName, metricIndex) => {
          if (!metricNames.has(metricName)) {
            context.addIssue({
              code: 'custom',
              path: ['suites', suiteIndex, 'cases', caseIndex, 'metrics', metricIndex],
              message: `metric is not defined: ${metricName}`,
            });
          }
        });
      });
    });
  });

/** Represents a validated v1 attest configuration file. */
type Config = z.infer<typeof configSchema>;

export {
  agentTargetSchema,
  caseSchema,
  configSchema,
  runSettingsSchema,
  suiteSchema,
  type AgentTarget,
  type CaseDefinition,
  type Config,
  type RunSettings,
  type Suite,
};
