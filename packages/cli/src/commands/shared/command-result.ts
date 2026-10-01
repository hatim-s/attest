import type {
  ApplicationCommandResult,
  MutationImportResult,
  MutationResult,
  ResourceListResult,
} from '@attest/local';

import { createCliSuccessResult, serializeCliResult } from '../../output/cli-protocol.js';

type SemanticOperation = MutationResult['operations'][number];

const renderOperation = (operation: SemanticOperation): string[] => [
  `  ${operation.op} ${operation.resource.type} ${operation.resource.id}${operation.previous_id === undefined ? '' : ` from ${operation.previous_id}`}`,
  ...operation.changes.map(({ change, path }) => `    ${change} ${path || '/'}`),
  ...operation.references_added.map(
    ({ id, path, type }) => `    reference added: ${type} ${id} at ${path}`,
  ),
  ...operation.references_removed.map(
    ({ id, path, type }) => `    reference removed: ${type} ${id} at ${path}`,
  ),
];

const renderImport = (result: MutationImportResult, includePreview: boolean): string[] => {
  const counts = `Import: read ${result.counts.read}, inserted ${result.counts.inserted}, updated ${result.counts.updated}, skipped ${result.counts.skipped}.`;
  if (!includePreview) return [counts];
  const rows = result.preview.map((row) => `  ${JSON.stringify(row)}`);
  return [
    counts,
    'Redacted normalized preview (up to 5 rows):',
    ...(rows.length === 0 ? ['  <empty>'] : rows),
  ];
};

const mutationHeader = (command: string, result: MutationResult): string => {
  if (result.resource === undefined) {
    const count = `${result.operations.length} operation(s)`;
    return result.dry_run
      ? `Dry run: ${command} would apply ${count}.`
      : `${command} applied ${count}.`;
  }
  const { id, type } = result.resource;
  return result.dry_run ? `Dry run: would update ${type} ${id}.` : `Updated ${type} ${id}.`;
};

/** Renders any mutation as a header, its import and preview details, and the semantic diff. */
const renderMutation = (
  command: string,
  result: Omit<MutationResult, 'shared_dataset_preview'>,
  projectHash: string | null | undefined,
): string => {
  const operations = result.operations.flatMap(renderOperation);
  const lines = [
    mutationHeader(command, result),
    ...(result.warnings ?? []).map((warning) => `Warning: ${warning}`),
    ...(result.affected_tests === undefined
      ? []
      : [`Affected consumer tests: ${result.affected_tests.join(', ')}.`]),
    ...(result.import === undefined ? [] : renderImport(result.import, result.dry_run)),
    ...(result.import_preview === undefined
      ? []
      : [`Redacted definition preview: ${JSON.stringify(result.import_preview)}`]),
    'Semantic diff:',
    ...(operations.length === 0 ? ['  no semantic changes'] : operations),
  ];
  if (result.dry_run) lines.push('Next: remove `--dry-run` to apply these changes.');
  if (projectHash !== undefined && projectHash !== null) lines.push(`Project hash: ${projectHash}`);
  if (!result.dry_run && result.next_command !== undefined) {
    lines.push(`Next: ${result.next_command}`);
  }
  return lines.join('\n');
};

/** Shows the mandatory shared-dataset preview ahead of the confirmed update it led to. */
const renderMutationResult = (
  command: string,
  result: MutationResult,
  projectHash: string | null | undefined,
): string => {
  const { shared_dataset_preview: preview, ...confirmed } = result;
  if (preview === undefined) return renderMutation(command, confirmed, projectHash);
  const previewResult = {
    ...confirmed,
    affected_tests: preview.affected_tests,
    committed: false,
    dry_run: true,
    import: preview.import ?? undefined,
    operations: preview.operations,
  };
  return [
    'Shared dataset update preview:',
    renderMutation(command, previewResult, preview.project_hash_after),
    'Confirmed shared dataset update:',
    renderMutation(command, confirmed, projectHash),
  ].join('\n\n');
};

/** Lists ids and names only; JSON output keeps every list field. */
const renderResourceList = (result: ResourceListResult): string => {
  if (result.items.length === 0) return `No ${result.resource_type}.`;
  switch (result.resource_type) {
    case 'agents':
    case 'datasets':
    case 'metrics':
    case 'tests':
      return result.items.map(({ id, name }) => `  ${id}  ${name}`).join('\n');
    case 'runs':
      return result.items.map(({ id }) => `  ${id}`).join('\n');
    default: {
      result satisfies never;
      throw new Error('Unsupported resource list.');
    }
  }
};

const renderHumanCommandResult = (
  command: string,
  commandResult: ApplicationCommandResult,
): string => {
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
    case 'list':
      return renderResourceList(commandResult.result);
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
        ? `Metric ${result.metric_id} matched expected_pass=${result.expected_pass}.`
        : `Metric ${result.metric_id} fixture is valid; ${result.kind} execution was not started.`;
    }
    case 'mutation':
      return renderMutationResult(command, commandResult.result, commandResult.projectHashAfter);
    default: {
      commandResult satisfies never;
      throw new Error('Unsupported command result.');
    }
  }
};

/** Renders a result that carries no project hashes as one JSON document or human text. */
const renderResult = <TResult>(
  command: string,
  output: 'human' | 'json',
  result: TResult,
  renderHuman: (result: TResult) => string,
): string =>
  output === 'json'
    ? serializeCliResult(createCliSuccessResult(command, result))
    : renderHuman(result);

/** Renders a local command result, with its project hashes, as JSON or human text. */
const renderCommandResult = (
  command: string,
  output: 'human' | 'json',
  commandResult: ApplicationCommandResult,
): string =>
  output === 'json'
    ? serializeCliResult(createCliSuccessResult(command, commandResult.result, commandResult))
    : renderHumanCommandResult(command, commandResult);

export { renderCommandResult, renderResult };
