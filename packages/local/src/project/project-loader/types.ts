import type { DatasetResource, ProjectResources, TestCase, JsonValue } from '@attest/contracts';

import type { ProjectDiagnostic } from '../project-errors.js';

import type { ProjectContentHashes } from '@attest/core';

type LoadedProject = ProjectResources & {
  contentHashes: ProjectContentHashes;
  manifestPath: string;
  projectHash: string;
  root: string;
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
};
