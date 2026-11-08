import { linkOptions } from '@tanstack/react-router';
import type { ShellBreadcrumb, ShellTarget } from '../../shell/navigation.js';
import { shortId } from '../../lib/format.js';

/**
 * The router destination for every shell target. Eval-scoped targets open the existing eval and
 * run pages until the compact eval routes replace them, so no link dead-ends.
 */
const targetLink = (target: ShellTarget) => {
  switch (target.kind) {
    case 'projects':
      return linkOptions({ to: '/' });
    case 'project':
      return linkOptions({
        to: '/projects/$projectKey',
        params: { projectKey: target.projectKey },
      });
    case 'project-runs':
      return linkOptions({
        to: '/projects/$projectKey/runs',
        params: { projectKey: target.projectKey },
      });
    case 'project-run':
    case 'run':
      return linkOptions({
        to: '/projects/$projectKey/runs/$runId',
        params: { projectKey: target.projectKey, runId: target.runId },
      });
    case 'project-run-case':
    case 'run-case':
      return linkOptions({
        to: '/projects/$projectKey/runs/$runId/cases/$suiteName/$caseId',
        params: {
          projectKey: target.projectKey,
          runId: target.runId,
          suiteName: target.evalId,
          caseId: target.caseId,
        },
      });
    case 'runs':
    case 'cases':
    case 'case':
      return linkOptions({
        to: '/projects/$projectKey/evals/$suiteName',
        params: { projectKey: target.projectKey, suiteName: target.evalId },
      });
  }
};

type Names = { project: (projectKey: string) => string };

/** Ancestors of the current page, ending with the page itself. */
const breadcrumbsFor = (current: ShellTarget, names: Names): ShellBreadcrumb[] => {
  const all: ShellBreadcrumb = {
    label: 'All projects',
    target: { kind: 'projects', sourceId: current.sourceId },
  };

  if (current.kind === 'projects') return [all];

  const scope = { sourceId: current.sourceId, projectKey: current.projectKey };

  const project: ShellBreadcrumb = {
    label: names.project(current.projectKey),
    target: { ...scope, kind: 'project' },
  };

  const allRuns: ShellBreadcrumb = {
    label: 'All runs',
    target: { ...scope, kind: 'project-runs' },
  };

  switch (current.kind) {
    case 'project':
      return [all, project];
    case 'project-runs':
      return [all, project, allRuns];
    case 'project-run':
      return [all, project, allRuns, { label: `Run ${shortId(current.runId)}`, target: current }];
    case 'project-run-case':
      return [
        all,
        project,
        allRuns,
        {
          label: `Run ${shortId(current.runId)}`,
          target: { ...scope, kind: 'project-run', runId: current.runId },
        },
        { label: current.caseId, target: current },
      ];
    case 'runs':
    case 'cases':
    case 'run':
    case 'case':
    case 'run-case': {
      const evaluation: ShellBreadcrumb = {
        label: current.evalId,
        target: { ...scope, kind: 'runs', evalId: current.evalId },
      };

      switch (current.kind) {
        case 'runs':
          return [all, project, evaluation];
        case 'cases':
          return [all, project, evaluation, { label: 'Test cases', target: current }];
        case 'run':
          return [
            all,
            project,
            evaluation,
            { label: `Run ${shortId(current.runId)}`, target: current },
          ];
        case 'case':
        case 'run-case':
          return [all, project, evaluation, { label: current.caseId, target: current }];
      }
    }
  }
};

export { targetLink, breadcrumbsFor };
