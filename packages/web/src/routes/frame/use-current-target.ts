import { useRouterState } from '@tanstack/react-router';
import type { ShellTarget } from '../../shell/navigation.js';

/** Adapts the committed router match to the shell vocabulary; an unmatched URL reads as All projects. */
const useCurrentTarget = (sourceId: string): ShellTarget =>
  useRouterState({
    select: (state): ShellTarget => {
      const match = state.matches.at(-1);

      switch (match?.routeId) {
        case '/projects/$projectKey/':
          return { kind: 'project', sourceId, projectKey: match.params.projectKey };
        case '/projects/$projectKey/runs':
          return { kind: 'project-runs', sourceId, projectKey: match.params.projectKey };
        case '/projects/$projectKey/runs/$runId':
          return { kind: 'project-run', sourceId, ...match.params };
        case '/projects/$projectKey/evals/$suiteName/runs':
          return {
            kind: 'runs',
            sourceId,
            projectKey: match.params.projectKey,
            evalId: match.params.suiteName,
          };
        case '/projects/$projectKey/evals/$suiteName/cases':
          return {
            kind: 'cases',
            sourceId,
            projectKey: match.params.projectKey,
            evalId: match.params.suiteName,
          };
        case '/projects/$projectKey/evals/$suiteName/runs/$runId':
          return {
            kind: 'run',
            sourceId,
            projectKey: match.params.projectKey,
            evalId: match.params.suiteName,
            runId: match.params.runId,
          };
        case '/projects/$projectKey/evals/$suiteName/runs/$runId/cases/$caseId':
          return {
            kind: 'run-case',
            sourceId,
            projectKey: match.params.projectKey,
            evalId: match.params.suiteName,
            runId: match.params.runId,
            caseId: match.params.caseId,
          };
        default:
          return { kind: 'projects', sourceId };
      }
    },
  });

export { useCurrentTarget };
