import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { RunStartRequest } from '@attest/core/records';
import { useDashboardSource } from '../../api/api-client-context.js';
import { NewRunDialog } from './new-run-dialog.js';
import '../../styles/compact/controls.css';

type NewRunButtonProps = {
  projectKey: string;
  /** Opened from an eval, the form starts with only that eval checked. */
  suiteName?: string;
};

/**
 * New run, shown only when the host can start runs. After a start it opens the new run: the eval
 * run page when the run selected one eval, else the project-level run page that lists its evals.
 */
const NewRunButton = ({ projectKey, suiteName }: NewRunButtonProps) => {
  const source = useDashboardSource();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  if (!source.capabilities.control) return null;

  const onStarted = (runId: string, selection: RunStartRequest['selection']) => {
    setOpen(false);
    const [only, ...rest] = 'testIds' in selection ? selection.testIds : [];

    void (only !== undefined && rest.length === 0
      ? navigate({
          to: '/projects/$projectKey/evals/$suiteName/runs/$runId',
          params: { projectKey, suiteName: only, runId },
        })
      : navigate({ to: '/projects/$projectKey/runs/$runId', params: { projectKey, runId } }));
  };

  return (
    <>
      <button type="button" className="attest-btn" onClick={() => setOpen(true)}>
        New run
      </button>
      {open && (
        <NewRunDialog
          key={projectKey}
          projectKey={projectKey}
          suiteName={suiteName}
          onClose={() => setOpen(false)}
          onStarted={onStarted}
        />
      )}
    </>
  );
};

export { NewRunButton };
