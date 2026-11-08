import { useState } from 'react';
import type { RunCancelOutcome, RunRecord } from '@attest/core/records';
import { useDashboardSource } from '../../api/api-client-context.js';
import { useCancelRun } from '../../api/queries/runs.js';
import { ErrorNotice } from '../../components/errors/error-notice.js';
import '../../styles/compact/controls.css';

const OUTCOME_MESSAGES = {
  cancellation_requested: 'Cancellation requested. The status changes once the run process stops.',
  already_cancelled: 'This run was already cancelled.',
  already_terminal: 'This run had already finished.',
} as const satisfies Record<RunCancelOutcome, string>;

/** `dismissed` is idle after the reader backed out, so focus returns to the Cancel run button. */
type CancelStep = 'idle' | 'confirming' | 'dismissed';

const focusOnMount = (element: HTMLElement | null) => element?.focus();

type CancelRunProps = {
  projectKey: string;
  run: RunRecord;
  /** Evals in the run. Cancelling stops all of them, so the label says so when there are several. */
  evalCount: number;
};

/**
 * Cancel for a running run, shown only when the host can control runs. The first click asks for
 * confirmation inline; Escape or Keep running backs out. The answer stays while the run winds down.
 */
const CancelRun = ({ projectKey, run, evalCount }: CancelRunProps) => {
  const source = useDashboardSource();
  const cancelRun = useCancelRun(source, projectKey, run.id);
  const [step, setStep] = useState<CancelStep>('idle');
  const outcome = cancelRun.data?.outcome;
  const label = evalCount > 1 ? `Cancel run (all ${evalCount} evals)` : 'Cancel run';

  if (!source.capabilities.control) return null;

  if (outcome !== undefined)
    return (
      <p className="attest-dim" role="status">
        {OUTCOME_MESSAGES[outcome]}
      </p>
    );

  if (run.status !== 'running') return null;

  if (cancelRun.isPending)
    return (
      <button type="button" className="attest-btn-2" disabled>
        Cancelling...
      </button>
    );

  return (
    <div className="attest-cancel">
      {step === 'confirming' ? (
        <div
          className="attest-confirm"
          role="group"
          aria-label="Cancel this run?"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setStep('dismissed');
          }}
        >
          <button
            ref={focusOnMount}
            type="button"
            className="attest-btn-2"
            onClick={() => setStep('dismissed')}
          >
            Keep running
          </button>
          <button
            type="button"
            className="attest-btn-danger"
            onClick={() => cancelRun.mutate(undefined, { onError: () => setStep('dismissed') })}
          >
            Confirm cancel
          </button>
        </div>
      ) : (
        <button
          ref={step === 'dismissed' ? focusOnMount : undefined}
          type="button"
          className="attest-btn-2"
          onClick={() => setStep('confirming')}
        >
          {label}
        </button>
      )}
      {cancelRun.error !== null && <ErrorNotice error={cancelRun.error} />}
    </div>
  );
};

export { CancelRun };
