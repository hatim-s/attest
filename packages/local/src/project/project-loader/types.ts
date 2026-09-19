import type { DatasetResource, ProjectResources, TestCase } from '@attest/contracts';

import type { JsonValue } from '../canonical-project.js';
import type { ProjectDiagnostic } from '../project-errors.js';

type ProjectContentHashes = {
  agents: Readonly<Record<string, string>>;
  datasets: Readonly<Record<string, { data: string; metadata: string }>>;
  manifest: string;
  metrics: Readonly<Record<string, string>>;
  tests: Readonly<Record<string, string>>;
};

type LoadedProject = ProjectResources & {
  contentHashes: ProjectContentHashes;
  manifestPath: string;
  projectHash: string;
  root: string;
};

type SchemaIssue = { message: string; path: PropertyKey[] };

type RuntimeSchema<Value> = {
  safeParse: (
    value: unknown,
  ) =>
    { data: Value; success: true } | { error: { issues: readonly SchemaIssue[] }; success: false };
};

type LoadedJsonResource<Value> = {
  diagnostics: ProjectDiagnostic[];
  hash?: string;
  rawValue?: JsonValue;
  source: string;
  value?: Value;
};

type LoadedDatasetResource = {
  caseLines: number[];
  dataHash?: string;
  diagnostics: ProjectDiagnostic[];
  metadataHash?: string;
  source: { data: string; metadata: string };
  value?: { cases: TestCase[]; metadata: DatasetResource };
};

export {
  type LoadedDatasetResource,
  type LoadedJsonResource,
  type LoadedProject,
  type ProjectContentHashes,
  type RuntimeSchema,
  type SchemaIssue,
};
