import { useState } from 'react';
import type { RunCancelOutcome, RunRecord } from '@attest/core/records';
import { useCancelRun } from '../api/queries.js';
import { Button, ErrorNotice } from '../components/shared/ui.js';

const OUTCOME_MESSAGES = {
  cancellation_requested: 'Cancellation requested. The status changes once the run process stops.',
  already_cancelled: 'This run was already cancelled.',
  already_terminal: 'This run had already finished.',
} as const satisfies Record<RunCancelOutcome, string>;

/** `dismissed` is idle after the reader backed out, so focus returns to the Cancel run button. */
type CancelStep = 'idle' | 'confirming' | 'dismissed';

const focusOnMount = (element: HTMLElement | null) => element?.focus();

/**
 * Cancel button for a running run. The first click asks for confirmation inline instead of a
 * browser dialog; Escape or Keep running backs out. The answer stays on screen while the run winds
 * down.
 */
const CancelRun = ({ projectKey, run }: { projectKey: string; run: RunRecord }) => {
  const cancelRun = useCancelRun(projectKey, run.id);
  const [step, setStep] = useState<CancelStep>('idle');
  const outcome = cancelRun.data?.outcome;

  if (outcome !== undefined) {
    return (
      <p className="notice" role="status">
        {OUTCOME_MESSAGES[outcome]}
      </p>
    );
  }

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
      {step === 'confirming' ? (
        <div
          className="confirm-group"
          role="group"
          aria-label="Cancel this run?"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setStep('dismissed');
          }}
        >
          <Button ref={focusOnMount} tone="secondary" onClick={() => setStep('dismissed')}>
            Keep running
          </Button>
          <Button
            tone="danger"
            onClick={() => cancelRun.mutate(undefined, { onError: () => setStep('dismissed') })}
          >
            Confirm cancel
          </Button>
        </div>
      ) : (
        <Button
          ref={step === 'dismissed' ? focusOnMount : undefined}
          tone="secondary"
          onClick={() => setStep('confirming')}
        >
          Cancel run
        </Button>
      )}
      {cancelRun.error !== null ? <ErrorNotice error={cancelRun.error} /> : null}
    </>
  );
};

export { CancelRun };
