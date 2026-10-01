import type {
  AgentResource,
  CliWarning,
  DatasetResource,
  MetricResource,
  ProjectManifest,
  TestCase,
  TestResource,
} from '@attest/contracts';
import type { RunRecord, TabularImportResult } from '@attest/core';

import type { NativeAgentConnectionResult } from '../agent/native-agent-adapter/test-native-agent.js';
import type { JsonValue } from '../../project/canonical-project.js';
import type { SemanticProjectOperation } from '../../project/transaction/index.js';

type CommandResult<Operation extends string, Result> = {
  operation: Operation;
  projectHashAfter?: string | null;
  projectHashBefore?: string | null;
  result: Result;
  warnings?: CliWarning[];
};

type ProjectCounts = {
  agents: number;
  datasets: number;
  metrics: number;
  tests: number;
};

type ProjectInitResult = {
  committed: boolean;
  dry_run: boolean;
  operations: readonly SemanticProjectOperation[];
  project: {
    id: string;
    name: string;
    root: string;
  };
};

type ProjectShowResult = {
  project: ProjectManifest;
  project_hash: string;
  root: string;
};

type ProjectValidateResult = {
  counts: ProjectCounts;
  project_hash: string;
  valid: true;
};

type AgentListItem = Pick<AgentResource, 'id' | 'name' | 'schema'> & {
  transport: AgentResource['transport']['kind'];
};

type DatasetListItem = Pick<DatasetResource, 'case_count' | 'id' | 'name' | 'schema'>;

type MetricListItem = Pick<MetricResource, 'id' | 'name' | 'schema'> & {
  kind: MetricResource['definition']['kind'];
};

type RunListItem = Omit<RunRecord, 'configJson'>;

type TestListItem = Pick<TestResource, 'agent_id' | 'id' | 'name' | 'schema'> & {
  case_count: number;
  dataset_count: number;
  metric_count: number;
};

type ResourceListResult =
  | { items: readonly AgentListItem[]; resource_type: 'agents' }
  | { items: readonly DatasetListItem[]; resource_type: 'datasets' }
  | { items: readonly MetricListItem[]; resource_type: 'metrics' }
  | { items: readonly RunListItem[]; resource_type: 'runs' }
  | { items: readonly TestListItem[]; resource_type: 'tests' };

type ResourceShowResult = {
  resource: JsonValue;
  resource_type: string;
};

type TestCaseListResult = {
  items: readonly Pick<TestCase, 'id' | 'tags'>[];
  test_id: string;
};

type TestCaseShowResult = {
  case: TestCase;
  test_id: string;
};

type AgentTestResult = NativeAgentConnectionResult & {
  recorded_run_id?: string;
};

type MetricTestResult =
  | {
      executed: false;
      fixture_valid: true;
      kind: 'http' | 'judge';
      metric_id: string;
      reason: 'external_execution_not_supported';
    }
  | {
      evaluation: JsonValue;
      executed: true;
      expected_pass: boolean;
      fixture_valid: true;
      kind: 'assertion' | 'exec';
      metric_id: string;
    };

type MutationResource = {
  id: string;
  type: 'dataset' | 'metric' | 'test' | 'test_case';
};

type MutationImportResult = Pick<
  TabularImportResult,
  'counts' | 'decisions' | 'format' | 'preview'
> & {
  source_content_hash: string;
};

type SharedDatasetPreview = {
  affected_tests: readonly string[];
  import: MutationImportResult | null;
  operations: readonly SemanticProjectOperation[];
  project_hash_after: string;
  project_hash_before: string;
};

type MutationResult = {
  affected_tests?: readonly string[];
  committed: boolean;
  dry_run: boolean;
  import?: MutationImportResult;
  imported_case_count?: number;
  import_preview?: JsonValue;
  next_command?: string;
  operations: readonly SemanticProjectOperation[];
  resource?: MutationResource;
  shared_dataset_preview?: SharedDatasetPreview;
  warnings?: readonly string[];
};

type ApplicationCommandResult =
  | CommandResult<'agent-test', AgentTestResult>
  | CommandResult<'list', ResourceListResult>
  | CommandResult<'metric-test', MetricTestResult>
  | CommandResult<'mutation', MutationResult>
  | CommandResult<'project-init', ProjectInitResult>
  | CommandResult<'project-show', ProjectShowResult>
  | CommandResult<'project-validate', ProjectValidateResult>
  | CommandResult<'show', ResourceShowResult>
  | CommandResult<'test-case-list', TestCaseListResult>
  | CommandResult<'test-case-show', TestCaseShowResult>;

export {
  type AgentListItem,
  type AgentTestResult,
  type ApplicationCommandResult,
  type CommandResult,
  type DatasetListItem,
  type MetricListItem,
  type MetricTestResult,
  type MutationImportResult,
  type MutationResult,
  type ProjectCounts,
  type ProjectInitResult,
  type ProjectShowResult,
  type ProjectValidateResult,
  type ResourceListResult,
  type ResourceShowResult,
  type RunListItem,
  type SharedDatasetPreview,
  type TestCaseListResult,
  type TestCaseShowResult,
  type TestListItem,
};
