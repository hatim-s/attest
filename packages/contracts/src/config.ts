import { z } from 'zod';

import type { ContractIssue } from './internal/issues.js';
import { metricDefinitionSchema } from './metric.js';
import { CONFIG_VERSION } from './versions.js';

type UnknownRecord = Record<string, unknown>;

const commonAgentFields = {
  env: z.array(z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
  retries: z.number().int().nonnegative().optional(),
};

const httpAgentUrlSchema = z
  .url()
  .refine(
    (url) => ['http:', 'https:'].includes(new URL(url).protocol),
    'url must use http or https',
  );

/** Encodes CLI and HTTP agent targets from docs/specs/config-format.md. */
const agentTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('cli'),
    command: z.array(z.string()).nonempty(),
    ...commonAgentFields,
  }),
  z.strictObject({
    type: z.literal('http'),
    url: httpAgentUrlSchema,
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

const suiteWithCasesSchema = z.strictObject({
  name: z.string(),
  metrics: z.array(z.string()),
  cases: z.array(caseSchema),
});

const suiteWithDatasetSchema = z.strictObject({
  name: z.string(),
  metrics: z.array(z.string()),
  dataset: z.string(),
});

/** Encodes the cases-or-dataset union from docs/specs/config-format.md. */
const suiteSchema = z
  .union([suiteWithCasesSchema, suiteWithDatasetSchema], {
    error: 'exactly one of cases or dataset must be present',
  })
  .meta({ id: 'Suite' });

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

const asRecord = (value: unknown): UnknownRecord | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as UnknownRecord;
};

const readArray = (record: UnknownRecord | undefined, fieldName: string): unknown[] => {
  const value = record?.[fieldName];
  return Array.isArray(value) ? value : [];
};

const readString = (record: UnknownRecord | undefined, fieldName: string): string | undefined => {
  const value = record?.[fieldName];
  return typeof value === 'string' ? value : undefined;
};

const readMetricNames = (candidate: unknown): Set<string> => {
  const config = asRecord(candidate);
  const names = readArray(config, 'metrics').flatMap((metric) => {
    const name = readString(asRecord(metric), 'name');
    return name === undefined ? [] : [name];
  });
  return new Set(names);
};

/** Reports repeated metric definition names while tolerating arbitrary input junk. */
const reportDuplicateMetricNames = (candidate: unknown): ContractIssue[] => {
  const config = asRecord(candidate);
  const metricNames = new Set<string>();
  const issues: ContractIssue[] = [];

  readArray(config, 'metrics').forEach((metric, metricIndex) => {
    const metricName = readString(asRecord(metric), 'name');
    if (metricName === undefined) {
      return;
    }

    if (metricNames.has(metricName)) {
      issues.push({
        path: `metrics.${metricIndex}.name`,
        message: `duplicate metric definition name: ${metricName}`,
      });
    }
    metricNames.add(metricName);
  });

  return issues;
};

/** Reports repeated suite names while tolerating arbitrary input junk. */
const reportDuplicateSuiteNames = (candidate: unknown): ContractIssue[] => {
  const config = asRecord(candidate);
  const suiteNames = new Set<string>();
  const issues: ContractIssue[] = [];

  readArray(config, 'suites').forEach((suite, suiteIndex) => {
    const suiteName = readString(asRecord(suite), 'name');
    if (suiteName === undefined) {
      return;
    }

    if (suiteNames.has(suiteName)) {
      issues.push({
        path: `suites.${suiteIndex}.name`,
        message: `duplicate suite name: ${suiteName}`,
      });
    }
    suiteNames.add(suiteName);
  });

  return issues;
};

/** Reports suite-level metric references that have no matching definition. */
const reportUnknownSuiteMetricReferences = (candidate: unknown): ContractIssue[] => {
  const config = asRecord(candidate);
  const metricNames = readMetricNames(candidate);
  const issues: ContractIssue[] = [];

  readArray(config, 'suites').forEach((suite, suiteIndex) => {
    readArray(asRecord(suite), 'metrics').forEach((metricName, metricIndex) => {
      if (typeof metricName !== 'string' || metricNames.has(metricName)) {
        return;
      }

      issues.push({
        path: `suites.${suiteIndex}.metrics.${metricIndex}`,
        message: `metric is not defined: ${metricName}`,
      });
    });
  });

  return issues;
};

/** Reports repeated inline case ids within their containing suite. */
const reportDuplicateCaseIds = (candidate: unknown): ContractIssue[] => {
  const config = asRecord(candidate);
  const issues: ContractIssue[] = [];

  readArray(config, 'suites').forEach((suite, suiteIndex) => {
    const caseIds = new Set<string>();
    readArray(asRecord(suite), 'cases').forEach((evaluationCase, caseIndex) => {
      const caseId = readString(asRecord(evaluationCase), 'id');
      if (caseId === undefined) {
        return;
      }

      if (caseIds.has(caseId)) {
        issues.push({
          path: `suites.${suiteIndex}.cases.${caseIndex}.id`,
          message: `duplicate case id: ${caseId}`,
        });
      }
      caseIds.add(caseId);
    });
  });

  return issues;
};

/** Reports case-level metric references that have no matching definition. */
const reportUnknownCaseMetricReferences = (candidate: unknown): ContractIssue[] => {
  const config = asRecord(candidate);
  const metricNames = readMetricNames(candidate);
  const issues: ContractIssue[] = [];

  readArray(config, 'suites').forEach((suite, suiteIndex) => {
    readArray(asRecord(suite), 'cases').forEach((evaluationCase, caseIndex) => {
      readArray(asRecord(evaluationCase), 'metrics').forEach((metricName, metricIndex) => {
        if (typeof metricName !== 'string' || metricNames.has(metricName)) {
          return;
        }

        issues.push({
          path: `suites.${suiteIndex}.cases.${caseIndex}.metrics.${metricIndex}`,
          message: `metric is not defined: ${metricName}`,
        });
      });
    });
  });

  return issues;
};

const addContractIssues = (issues: ContractIssue[], context: z.RefinementCtx): void => {
  for (const issue of issues) {
    context.addIssue({
      code: 'custom',
      path: issue.path.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
      message: issue.message,
    });
  }
};

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
    addContractIssues(reportDuplicateMetricNames(config), context);
    addContractIssues(reportDuplicateSuiteNames(config), context);
    addContractIssues(reportUnknownSuiteMetricReferences(config), context);
    addContractIssues(reportDuplicateCaseIds(config), context);
    addContractIssues(reportUnknownCaseMetricReferences(config), context);
  });

/** Represents a validated v1 attest configuration file. */
type Config = z.infer<typeof configSchema>;

export {
  agentTargetSchema,
  caseSchema,
  configSchema,
  reportDuplicateCaseIds,
  reportDuplicateMetricNames,
  reportDuplicateSuiteNames,
  reportUnknownCaseMetricReferences,
  reportUnknownSuiteMetricReferences,
  runSettingsSchema,
  suiteSchema,
  type AgentTarget,
  type CaseDefinition,
  type Config,
  type RunSettings,
  type Suite,
};
