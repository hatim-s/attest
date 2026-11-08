import { useRouterState } from '@tanstack/react-router';
import type { ShellTarget } from '../../shell/navigation.js';

/**
 * Adapts the committed router match to the shell vocabulary. The comparison page has no target of
 * its own, so it reads as its candidate run; an unmatched URL reads as the project index.
 */
const useCurrentTarget = (sourceId: string): ShellTarget =>
  useRouterState({
    select: (state): ShellTarget => {
      const match = state.matches.at(-1);

      switch (match?.routeId) {
        case '/projects/$projectKey/':
          return { kind: 'project', sourceId, projectKey: match.params.projectKey };
        case '/projects/$projectKey/workspace/runs/':
          return { kind: 'project-runs', sourceId, projectKey: match.params.projectKey };
        case '/projects/$projectKey/workspace/runs/$runId':
          return { kind: 'project-run', sourceId, ...match.params };
        case '/projects/$projectKey/workspace/runs/$runId/cases/$suiteName/$caseId':
          return {
            kind: 'project-run-case',
            sourceId,
            projectKey: match.params.projectKey,
            evalId: match.params.suiteName,
            runId: match.params.runId,
            caseId: match.params.caseId,
          };
        case '/projects/$projectKey/workspace/compare/$baseRunId/$candidateRunId':
          return {
            kind: 'project-run',
            sourceId,
            projectKey: match.params.projectKey,
            runId: match.params.candidateRunId,
          };
        case '/projects/$projectKey/workspace/evals/$suiteName':
          return {
            kind: 'runs',
            sourceId,
            projectKey: match.params.projectKey,
            evalId: match.params.suiteName,
          };
        default:
          return { kind: 'projects', sourceId };
      }
    },
  });

export { useCurrentTarget };
