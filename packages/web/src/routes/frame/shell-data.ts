import type { UseQueryResult } from '@tanstack/react-query';
import type { ProjectOverviewList } from '@attest/api/contract';
import type { EvalPage } from '@attest/core/records';
import type {
  NavigationData,
  RecentLabel,
  RecentTarget,
  ShellEval,
  ShellProject,
} from '../../shell/navigation.js';
import { shortRunId } from '../../lib/format.js';

/** Keeps the last good data through a failed refetch; only a first failure becomes an error. */
const navigationData = <Data, Item>(
  query: UseQueryResult<Data>,
  items: (data: Data) => readonly Item[],
): NavigationData<Item> => {
  if (query.data !== undefined) return { status: 'ready', items: items(query.data) };

  if (query.error !== null)
    return { status: 'error', message: query.error.message, retry: () => void query.refetch() };

  return { status: 'loading' };
};

/** Every catalog project, readable or not; a broken store explains itself on its own page. */
const shellProjects = (list: ProjectOverviewList): ShellProject[] =>
  list.items.map((entry) => ({
    key: entry.project.key,
    name: entry.project.name,
    failing:
      entry.status === 'ready' &&
      entry.overview.evals.items.some((evaluation) => evaluation.failing === true),
  }));

/** A running slice outranks the last verdict, as the eval page will show it running. */
const shellEvals = (page: EvalPage): ShellEval[] =>
  page.items.map((evaluation) => ({
    id: evaluation.suiteName,
    name: evaluation.suiteName,
    mark:
      evaluation.latest.state === 'running'
        ? 'running'
        : evaluation.failing === true
          ? 'failing'
          : null,
  }));

/**
 * Names a recent page from the catalog the shell already holds. A project that left the catalog
 * resolves to nothing, so its recents hide instead of linking into a missing project.
 */
const recentLabel = (
  list: ProjectOverviewList | undefined,
  target: RecentTarget,
): RecentLabel | undefined => {
  const project = list?.items.find((entry) => entry.project.key === target.projectKey)?.project;

  if (project === undefined) return undefined;

  switch (target.kind) {
    case 'project-run':
      return { label: `Run ${shortRunId(target.runId)}`, context: project.name };
    case 'run':
      return {
        label: `Run ${shortRunId(target.runId)}`,
        context: `${project.name}, ${target.evalId}`,
      };
    case 'case':
      return { label: target.caseId, context: `${project.name}, ${target.evalId}` };
    case 'project-run-case':
    case 'run-case':
      return {
        label: target.caseId,
        context: `${project.name}, ${target.evalId}, run ${shortRunId(target.runId)}`,
      };
  }
};

export { navigationData, shellProjects, shellEvals, recentLabel };
