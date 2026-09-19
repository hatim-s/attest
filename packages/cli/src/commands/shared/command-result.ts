import type {
  ApplicationCommandResult,
  CommandResult as LocalCommandResult,
  MutationResult,
} from '@attest/local';
import type { JsonValue } from '@attest/contracts';

import { createCliSuccessResult, serializeCliResult } from '../../output/cli-protocol.js';

type SchemaListResult = {
  items: readonly {
    file: string;
    id: string;
  }[];
};

type SchemaPrintResult = {
  file: string;
  id: string;
  schema: JsonValue;
};

type CommandResult =
  | ApplicationCommandResult
  | LocalCommandResult<'schema-list', SchemaListResult>
  | LocalCommandResult<'schema-print', SchemaPrintResult>;

const renderAgentMutation = (
  command: string,
  result: MutationResult,
  projectHash?: string | null,
): string => {
  const operationLines = result.operations.map((operation) => {
    const renamed = operation.previous_id === undefined ? '' : ` from ${operation.previous_id}`;
    const changes = operation.changes.map(({ path }) => path).join(', ');
    const references = [
      ...operation.references_added.map(({ id }) => `+ref:${id}`),
      ...operation.references_removed.map(({ id }) => `-ref:${id}`),
    ].join(', ');
    const details = [changes, references].filter((value) => value.length > 0).join('; ');
    return `- ${operation.op} ${operation.resource.type} ${operation.resource.id}${renamed}${details.length === 0 ? '' : ` (${details})`}`;
  });
  return [
    `${command} ${result.dry_run ? 'preview' : 'changes'}:`,
    ...(operationLines.length === 0 ? ['- no semantic changes'] : operationLines),
    ...(result.warnings ?? []).map((warning) => `Warning: ${warning}`),
    ...(result.import_preview === undefined
      ? []
      : [`Redacted definition preview: ${JSON.stringify(result.import_preview)}`]),
    `${command} ${result.dry_run ? 'would apply' : 'applied'} ${result.operations.length} operation(s).`,
    ...(projectHash === undefined || projectHash === null ? [] : [`Project hash: ${projectHash}`]),
    ...(!result.dry_run && result.next_command !== undefined
      ? [`Next: ${result.next_command}`]
      : []),
  ].join('\n');
};

const renderMetricMutation = (result: MutationResult, projectHash?: string | null): string => {
  if (result.resource === undefined) return '';
  return [
    `${result.dry_run ? 'Dry run: would update' : 'Updated'} metric ${result.resource.id}.`,
    ...(result.dry_run
      ? [
          'Semantic diff:',
          ...result.operations.map((operation) => {
            const previous =
              operation.previous_id === undefined ? '' : ` from ${operation.previous_id}`;
            return `  ${operation.op} ${operation.resource.type} ${operation.resource.id}${previous}`;
          }),
          'Next: remove `--dry-run` to apply these changes.',
        ]
      : []),
    ...(projectHash === undefined || projectHash === null ? [] : [`Project hash: ${projectHash}`]),
  ].join('\n');
};

const renderTestMutationOperations = (operations: MutationResult['operations']): string[] =>
  operations.flatMap((operation) => [
    `  ${operation.op} ${operation.resource.type} ${operation.resource.id}`,
    ...operation.changes.map(({ change, path }) => `    ${change} ${path || '/'}`),
    ...operation.references_added.map(
      ({ id, path, type }) => `    reference added: ${type} ${id} at ${path}`,
    ),
    ...operation.references_removed.map(
      ({ id, path, type }) => `    reference removed: ${type} ${id} at ${path}`,
    ),
  ]);

const renderImportSummary = (
  result: NonNullable<MutationResult['import']>,
  includePreview: boolean,
): string[] => [
  `Import: read ${result.counts.read}, inserted ${result.counts.inserted}, updated ${result.counts.updated}, skipped ${result.counts.skipped}.`,
  ...(includePreview
    ? [
        'Redacted normalized preview (up to 5 rows):',
        ...(result.preview.length === 0
          ? ['  <empty>']
          : result.preview.map((row) => `  ${JSON.stringify(row)}`)),
      ]
    : []),
];

const renderTestMutation = (result: MutationResult, projectHash?: string | null): string => {
  if (result.resource === undefined) return '';
  return [
    `${result.dry_run ? 'Dry run: would update' : 'updated'} ${result.resource.type} ${result.resource.id}.`,
    ...(result.affected_tests === undefined
      ? []
      : [`Affected consumer tests: ${result.affected_tests.join(', ')}.`]),
    ...(result.import === undefined ? [] : renderImportSummary(result.import, result.dry_run)),
    ...(result.dry_run
      ? [
          'Semantic diff:',
          ...renderTestMutationOperations(result.operations),
          'Next: remove `--dry-run` from this command to apply these changes.',
        ]
      : []),
    ...(projectHash === undefined || projectHash === null ? [] : [`Project hash: ${projectHash}`]),
  ].join('\n');
};

const renderMutation = (
  command: string,
  result: MutationResult,
  projectHash?: string | null,
): string => {
  if (result.shared_dataset_preview !== undefined) {
    const { shared_dataset_preview: preview, ...confirmedResult } = result;
    const previewResult: MutationResult = {
      ...confirmedResult,
      committed: false,
      dry_run: true,
      operations: preview.operations,
      affected_tests: preview.affected_tests,
      ...(preview.import === null ? {} : { import: preview.import }),
    };
    return [
      'Shared dataset update preview:',
      renderMutation(command, previewResult, preview.project_hash_after),
      'Confirmed shared dataset update:',
      renderMutation(command, confirmedResult, projectHash),
    ].join('\n\n');
  }
  if (result.resource === undefined) {
    return renderAgentMutation(command, result, projectHash);
  }
  return result.resource.type === 'metric'
    ? renderMetricMutation(result, projectHash)
    : renderTestMutation(result, projectHash);
};

const unreachableOperation = (operation: never): never => {
  throw new Error(`Unsupported command result operation: ${String(operation)}`);
};

/** Renders one typed application result without moving terminal prose into the local package. */
const renderHumanCommandResult = (command: string, commandResult: CommandResult): string => {
  switch (commandResult.operation) {
    case 'project-init': {
      const { dry_run: dryRun, project } = commandResult.result;
      return `${dryRun ? 'Dry run: would initialize' : 'Initialized'} Attest project "${project.name}" in ${project.root}.\nProject hash: ${commandResult.projectHashAfter ?? ''}`;
    }
    case 'project-show': {
      const { project, project_hash: projectHash, root } = commandResult.result;
      return [
        `Project ${project.name}`,
        `  id: ${project.project_id}`,
        `  root: ${root}`,
        `  hash: ${projectHash}`,
        `  agents: ${project.resources.agents.length}`,
        `  tests: ${project.resources.tests.length}`,
        `  datasets: ${project.resources.datasets.length}`,
        `  metrics: ${project.resources.metrics.length}`,
      ].join('\n');
    }
    case 'project-validate': {
      const { counts, project_hash: projectHash } = commandResult.result;
      return `Project is valid.\nHash: ${projectHash}\nResources: ${counts.agents} agents, ${counts.tests} tests, ${counts.datasets} datasets, ${counts.metrics} metrics`;
    }
    case 'list': {
      const { items, resource_type: resourceType } = commandResult.result;
      if (items.length === 0) return `No ${resourceType}.`;
      return items
        .map((item) => `  ${item.id}${item.name === undefined ? '' : `  ${item.name}`}`)
        .join('\n');
    }
    case 'test-case-list': {
      const { items } = commandResult.result;
      if (items.length === 0) return 'No direct cases.';
      return items.map((item) => `  ${item.id}`).join('\n');
    }
    case 'show':
      return JSON.stringify(commandResult.result.resource, undefined, 2);
    case 'test-case-show':
      return JSON.stringify(commandResult.result.case, undefined, 2);
    case 'agent-test': {
      const { agent_id: agentId, recorded_run_id: recordedRunId } = commandResult.result;
      return `Agent ${agentId} passed the connection test.${recordedRunId === undefined ? '' : `\nRecorded run: ${recordedRunId}`}`;
    }
    case 'metric-test': {
      const result = commandResult.result;
      return result.executed
        ? `Metric ${result.metric_id} matched the fixture expectation.`
        : `Metric ${result.metric_id} fixture is valid; ${result.kind} execution was not started.`;
    }
    case 'mutation':
      return renderMutation(command, commandResult.result, commandResult.projectHashAfter);
    case 'schema-list':
      return commandResult.result.items
        .map(({ file, id }) => `  ${id}${id === file ? '' : `  (${file})`}`)
        .join('\n');
    case 'schema-print':
      return JSON.stringify(commandResult.result.schema, undefined, 2);
    default:
      return unreachableOperation(commandResult);
  }
};

/** Renders application data through the selected CLI output contract. */
const renderCommandResult = (
  command: string,
  output: 'human' | 'json',
  commandResult: CommandResult,
): string =>
  output === 'json'
    ? serializeCliResult(createCliSuccessResult(command, commandResult.result, commandResult))
    : renderHumanCommandResult(command, commandResult);

export {
  renderCommandResult,
  renderHumanCommandResult,
  type CommandResult,
  type SchemaListResult,
  type SchemaPrintResult,
};
