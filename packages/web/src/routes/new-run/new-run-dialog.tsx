import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RunStartRequest, TestSummary } from '@attest/core/records';
import { useDashboardSource } from '../../api/api-client-context.js';
import { projectOverviewQueryOptions } from '../../api/queries/projects.js';
import { testsQueryOptions, useStartRun } from '../../api/queries/runs.js';
import { ErrorNotice } from '../../components/errors/error-notice.js';
import { formatCount } from '../../lib/format.js';
import { selectTests, toRunStartRequest } from './run-start-request.js';

type NewRunDialogProps = {
  projectKey: string;
  suiteName: string | undefined;
  onClose: () => void;
  onStarted: (runId: string, selection: RunStartRequest['selection']) => void;
};

/** One checkbox per test, with its id, case count and tags under the name. */
const TestOption = ({
  test,
  checked,
  onToggle,
}: {
  test: TestSummary;
  checked: boolean;
  onToggle: () => void;
}) => (
  <label className="attest-check">
    <input type="checkbox" checked={checked} onChange={onToggle} />
    <span>
      <strong>{test.name}</strong>
      <span className="attest-dim">
        <code>{test.id}</code> {formatCount(test.caseCount, 'case')}
        {test.tags.length > 0 && `, ${test.tags.join(', ')}`}
      </span>
    </span>
  </label>
);

/** A labelled number input; blank means the project default. */
const NumberField = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) => {
  const id = useId();

  return (
    <div className="attest-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
        value={value}
        placeholder="Project default"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
};

/**
 * The new-run form in a modal dialog. A failed start keeps everything typed, so the reader can fix
 * what the CLI reported and try again. Escape, the close button and the backdrop all dismiss it.
 */
const NewRunDialog = ({ projectKey, suiteName, onClose, onStarted }: NewRunDialogProps) => {
  const source = useDashboardSource();
  const dialog = useRef<HTMLDialogElement>(null);
  const tests = useQuery(testsQueryOptions(source, projectKey));

  const running =
    (useQuery(projectOverviewQueryOptions(source, projectKey)).data?.runningRunCount ?? 0) > 0;

  const startRun = useStartRun(source, projectKey);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>();
  const [tags, setTags] = useState('');
  const [concurrency, setConcurrency] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState('');
  const titleId = useId();
  const tagsId = useId();
  const items = tests.data ?? [];

  // Opened from an eval, every other test starts unchecked until the reader changes the list.
  const skipped =
    unchecked ??
    new Set(
      suiteName === undefined
        ? []
        : items.flatMap((test) => (test.id === suiteName ? [] : [test.id])),
    );

  const selection = selectTests(
    items.map((test) => test.id),
    skipped,
  );

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const toggle = (testId: string) => {
    const next = new Set(skipped);

    if (!next.delete(testId)) next.add(testId);
    setUnchecked(next);
  };

  return (
    <dialog
      ref={dialog}
      className="attest-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        // A click on the dialog element itself lands on the backdrop, outside the panel.
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <form
        className="attest-dialog-panel"
        onSubmit={(event) => {
          event.preventDefault();

          if (selection === undefined) return;

          startRun.mutate(toRunStartRequest({ selection, tags, concurrency, timeoutSeconds }), {
            onSuccess: ({ runId }) => onStarted(runId, selection),
          });
        }}
      >
        <header className="attest-dialog-head">
          <h2 id={titleId}>New run</h2>
          <button
            type="button"
            className="attest-mini-btn"
            aria-label="Close the new run form"
            onClick={() => dialog.current?.close()}
          >
            Close
          </button>
        </header>
        <div className="attest-dialog-body">
          {running && (
            <p className="attest-dim">
              Another run in this project is still running. This one runs alongside it.
            </p>
          )}
          <fieldset className="attest-fieldset">
            <legend>
              Tests{' '}
              {items.length > 0 && (
                <span className="attest-dim">
                  {items.length - items.filter((test) => skipped.has(test.id)).length} of{' '}
                  {items.length} selected
                </span>
              )}
            </legend>
            {tests.isPending && (
              <p className="attest-loading" role="status">
                Loading tests...
              </p>
            )}
            {tests.error !== null && <ErrorNotice error={tests.error} />}
            {tests.data?.length === 0 && (
              <p className="attest-dim">
                This project has no tests. Add one with <code>attest test add</code>.
              </p>
            )}
            {items.map((test) => (
              <TestOption
                key={test.id}
                test={test}
                checked={!skipped.has(test.id)}
                onToggle={() => toggle(test.id)}
              />
            ))}
          </fieldset>
          <div className="attest-field">
            <label htmlFor={tagsId}>Tags</label>
            <input
              id={tagsId}
              type="text"
              value={tags}
              placeholder="smoke, billing"
              aria-describedby={`${tagsId}-hint`}
              onChange={(event) => setTags(event.target.value)}
            />
            <small id={`${tagsId}-hint`}>
              Runs only the cases that carry every tag. Separate tags with commas.
            </small>
          </div>
          <div className="attest-field-row">
            <NumberField
              label="Concurrency (parallel cases)"
              value={concurrency}
              onChange={setConcurrency}
            />
            <NumberField
              label="Run timeout (seconds)"
              value={timeoutSeconds}
              onChange={setTimeoutSeconds}
            />
          </div>
        </div>
        <footer className="attest-dialog-foot">
          {startRun.error !== null && <ErrorNotice error={startRun.error} />}
          <button
            type="submit"
            className="attest-btn"
            disabled={selection === undefined || startRun.isPending}
          >
            {startRun.isPending ? 'Starting...' : 'Start run'}
          </button>
        </footer>
      </form>
    </dialog>
  );
};

export { NewRunDialog };
