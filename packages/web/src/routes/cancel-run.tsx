import { useState } from 'react';
import type { RunCancelOutcome, RunRecord } from '@attest/core/records';
import { useCancelRun } from '../api/queries.js';
import { Button, ErrorNotice } from '../components/shared/ui.js';

const OUTCOME_MESSAGES = {
  cancellation_requested: 'Cancellation requested. The status changes once the run process stops.',
  already_cancelled: 'This run was already cancelled.',
  already_terminal: 'This run had already finished.',
} as const satisfies Record<RunCancelOutcome, string>;

/**
 * Cancel button for a running run. The first click asks for confirmation inline instead of a
 * browser dialog; the answer stays on screen while the run winds down.
 */
const CancelRun = ({ projectKey, run }: { projectKey: string; run: RunRecord }) => {
  const cancelRun = useCancelRun(projectKey, run.id);
  const [isConfirming, setConfirming] = useState(false);
  const outcome = cancelRun.data?.outcome;

  if (outcome !== undefined) return <p className="notice">{OUTCOME_MESSAGES[outcome]}</p>;

  if (run.status !== 'running') return null;

  if (cancelRun.isPending) {
    return (
      <Button disabled tone="secondary">
        Cancelling…
      </Button>
    );
  }

  return (
    <>
      {isConfirming ? (
        <>
          <Button tone="ghost" onClick={() => setConfirming(false)}>
            Keep running
          </Button>
          <Button
            tone="primary"
            onClick={() => cancelRun.mutate(undefined, { onSettled: () => setConfirming(false) })}
          >
            Confirm cancel
          </Button>
        </>
      ) : (
        <Button tone="secondary" onClick={() => setConfirming(true)}>
          Cancel run
        </Button>
      )}
      {cancelRun.error !== null ? <ErrorNotice error={cancelRun.error} /> : null}
    </>
  );
};

export { CancelRun };
