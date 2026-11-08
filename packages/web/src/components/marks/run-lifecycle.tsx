import type { RunStatus } from '@attest/core/records';
import { StatusMark, type StatusTone } from './status-mark.js';

const LIFECYCLE = {
  running: { word: 'Running', tone: 'running' },
  failed: { word: 'Run failed', tone: 'run-failed' },
  cancelled: { word: 'Cancelled', tone: 'stopped' },
} as const satisfies Record<Exclude<RunStatus, 'completed'>, { word: string; tone: StatusTone }>;

/**
 * A run's lifecycle in a circle and a word. A completed run renders nothing: completion is the
 * expected state, and its verdict is reported separately.
 */
const RunLifecycle = ({ status }: { status: RunStatus }) => {
  if (status === 'completed') return null;

  const { word, tone } = LIFECYCLE[status];

  return (
    <span className="attest-status" data-tone={tone}>
      <StatusMark tone={tone} />
      {word}
    </span>
  );
};

export { RunLifecycle };
