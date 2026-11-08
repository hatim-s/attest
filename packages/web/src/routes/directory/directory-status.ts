import type { ProjectRunOverview } from '@attest/core/records';
import { formatCount } from '../../lib/format.js';

/** `failing` is the only tone drawn in orange. */
type ProjectStatus = { text: string; tone: 'failing' | 'running' | 'passing' | 'none' };

/**
 * One phrase for a directory row, from the overview's precomputed eval verdicts. Evals exist only
 * once a run recorded them, so an empty list means no runs yet. An eval whose last terminal slice
 * has no verdict (`failing: null`) is never counted as passing.
 */
const projectStatus = ({
  evals,
  runningRunCount,
}: Pick<ProjectRunOverview, 'evals' | 'runningRunCount'>): ProjectStatus => {
  const failing = evals.items.filter((evaluation) => evaluation.failing === true).length;
  const unknown = evals.items.filter((evaluation) => evaluation.failing === null).length;

  if (failing > 0) return { text: `${formatCount(failing, 'eval')} failing`, tone: 'failing' };

  if (runningRunCount > 0) return { text: 'Running', tone: 'running' };

  if (evals.items.length === 0) return { text: 'No runs yet', tone: 'none' };

  if (unknown === 0) return { text: 'All passing', tone: 'passing' };

  if (unknown === evals.items.length) return { text: 'No verdict yet', tone: 'none' };

  return {
    text: `${evals.items.length - unknown} passing, ${unknown} without a verdict`,
    tone: 'passing',
  };
};

export { projectStatus, type ProjectStatus };
