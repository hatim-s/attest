import { useId, useState } from 'react';
import type { TestSummary } from '@attest/core/records';
import { useRuns, useStartRun, useTests } from '../api/queries.js';
import { Drawer } from '../components/shared/drawer.js';
import { Badge, Button, ErrorNotice, Loading } from '../components/shared/ui.js';
import { formatCount } from '../lib/format.js';
import { selectTests, toRunStartRequest } from './run-start-request.js';

type TestOptionProps = {
  test: TestSummary;
  checked: boolean;
  onToggle: (testId: string) => void;
};

const TestOption = ({ test, checked, onToggle }: TestOptionProps) => {
  const metaId = useId();

  return (
    <label className="test-option">
      <input
        type="checkbox"
        checked={checked}
        aria-describedby={metaId}
        onChange={() => onToggle(test.id)}
      />
      <span className="test-option-text">
        <strong>{test.name}</strong>
        <span className="test-option-meta" id={metaId}>
          <code>{test.id}</code>
          <span>{formatCount(test.caseCount, 'case')}</span>
          {test.tags.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </span>
      </span>
    </label>
  );
};

type NumberFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
};

const NumberField = ({ label, value, onChange }: NumberFieldProps) => {
  const id = useId();

  return (
    <div className="field">
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

type NewRunFormProps = {
  projectKey: string;
  onStarted: (runId: string) => void;
};

/**
 * The fields of one project's new run. A failed start keeps everything the reader typed, so they
 * can fix the cause the CLI reported and try again.
 */
const NewRunForm = ({ projectKey, onStarted }: NewRunFormProps) => {
  const testsQuery = useTests(projectKey);
  const startRun = useStartRun(projectKey);
  const hasRunningRun = useRuns(projectKey).data?.items.some((run) => run.status === 'running');
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [tags, setTags] = useState('');
  const [concurrency, setConcurrency] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState('');
  const tagsId = useId();
  const tests = testsQuery.data ?? [];
  const checkedCount = tests.filter((test) => !unchecked.has(test.id)).length;

  const selection = selectTests(
    tests.map((test) => test.id),
    unchecked,
  );

  const toggle = (testId: string) =>
    setUnchecked((previous) => {
      const next = new Set(previous);

      if (!next.delete(testId)) next.add(testId);

      return next;
    });

  return (
    <form
      className="new-run-form"
      onSubmit={(event) => {
        event.preventDefault();

        if (selection === undefined) return;

        startRun.mutate(toRunStartRequest({ selection, tags, concurrency, timeoutSeconds }), {
          onSuccess: ({ runId }) => onStarted(runId),
        });
      }}
    >
      <div className="drawer-content">
        {hasRunningRun === true ? (
          <p className="notice">
            Another run in this project is still running. This one runs alongside it.
          </p>
        ) : null}
        <fieldset className="detail-section test-checklist">
          <legend>
            Tests{' '}
            {tests.length > 0 ? (
              <span className="test-checklist-count">
                {checkedCount} of {tests.length} selected
              </span>
            ) : null}
          </legend>
          {testsQuery.isLoading ? <Loading label="Loading tests" /> : null}
          {testsQuery.error !== null ? <ErrorNotice error={testsQuery.error} /> : null}
          {testsQuery.data?.length === 0 ? (
            <p className="empty-compact">
              This project has no tests. Add one with <code>attest test add</code>.
            </p>
          ) : null}
          {tests.length > 0 ? (
            <div className="test-checklist-options">
              {tests.map((test) => (
                <TestOption
                  key={test.id}
                  test={test}
                  checked={!unchecked.has(test.id)}
                  onToggle={toggle}
                />
              ))}
            </div>
          ) : null}
        </fieldset>
        <div className="detail-section form-fields">
          <div className="field field-wide">
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
      <footer className="drawer-footer">
        {startRun.error !== null ? <ErrorNotice error={startRun.error} /> : null}
        <Button
          type="submit"
          tone="primary"
          disabled={selection === undefined || startRun.isPending}
        >
          {startRun.isPending ? 'Starting…' : 'Start run'}
        </Button>
      </footer>
    </form>
  );
};

type NewRunDrawerProps = NewRunFormProps & { onClose: () => void };

/**
 * Drawer for starting a run. The form is keyed by project, so moving to another project while the
 * drawer is open starts from a clean form instead of carrying the old selection over.
 */
const NewRunDrawer = ({ projectKey, onClose, onStarted }: NewRunDrawerProps) => (
  <Drawer
    label="Start a run"
    eyebrow={projectKey}
    title="Start a run"
    closeLabel="Close the new run form"
    onClose={onClose}
  >
    <NewRunForm key={projectKey} projectKey={projectKey} onStarted={onStarted} />
  </Drawer>
);

export { NewRunDrawer };
