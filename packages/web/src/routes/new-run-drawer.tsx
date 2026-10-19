import { useState } from 'react';
import type { TestSummary } from '@attest/core/records';
import { useRuns, useStartRun, useTests } from '../api/queries.js';
import { Drawer } from '../components/shared/drawer.js';
import { Badge, Button, ErrorNotice, Loading } from '../components/shared/ui.js';
import { formatCount } from '../lib/format.js';
import { selectTests, toRunStartRequest } from './run-start-request.js';

type TestChecklistProps = {
  tests: TestSummary[];
  unchecked: ReadonlySet<string>;
  onToggle: (testId: string) => void;
};

const TestChecklist = ({ tests, unchecked, onToggle }: TestChecklistProps) => (
  <div className="test-checklist">
    {tests.map((test) => (
      <label className="test-option" key={test.id}>
        <input
          type="checkbox"
          checked={!unchecked.has(test.id)}
          onChange={() => onToggle(test.id)}
        />
        <span className="test-option-text">
          <strong>{test.name}</strong>
          <span className="test-option-meta">
            <code>{test.id}</code>
            <span>{formatCount(test.caseCount, 'case')}</span>
            {test.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </span>
        </span>
      </label>
    ))}
  </div>
);

type NewRunDrawerProps = {
  projectKey: string;
  onClose: () => void;
  onStarted: (runId: string) => void;
};

/**
 * Form for starting a run in one project. A failed start keeps everything the reader typed, so
 * they can fix the cause the CLI reported and try again.
 */
const NewRunDrawer = ({ projectKey, onClose, onStarted }: NewRunDrawerProps) => {
  const testsQuery = useTests(projectKey);
  const startRun = useStartRun(projectKey);
  const hasRunningRun = useRuns(projectKey).data?.items.some((run) => run.status === 'running');
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [tags, setTags] = useState('');
  const [concurrency, setConcurrency] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState('');
  const tests = testsQuery.data ?? [];

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
    <Drawer
      label="Start a run"
      eyebrow={projectKey}
      title="Start a run"
      closeLabel="Close the new run form"
      onClose={onClose}
    >
      <form
        className="drawer-content"
        onSubmit={(event) => {
          event.preventDefault();

          if (selection === undefined) return;

          startRun.mutate(toRunStartRequest({ selection, tags, concurrency, timeoutSeconds }), {
            onSuccess: ({ runId }) => onStarted(runId),
          });
        }}
      >
        {hasRunningRun === true ? (
          <p className="notice">
            A run is already in progress in this project. A new one runs alongside it.
          </p>
        ) : null}
        <section className="detail-section">
          <h4>Tests</h4>
          {testsQuery.isLoading ? <Loading label="Loading tests" /> : null}
          {testsQuery.error !== null ? <ErrorNotice error={testsQuery.error} /> : null}
          {testsQuery.data?.length === 0 ? (
            <p className="empty-compact">
              This project has no tests. Add one with <code>attest test add</code>.
            </p>
          ) : null}
          <TestChecklist tests={tests} unchecked={unchecked} onToggle={toggle} />
        </section>
        <section className="detail-section form-fields">
          <label className="field">
            Tags
            <input
              type="text"
              value={tags}
              placeholder="smoke, billing"
              onChange={(event) => setTags(event.target.value)}
            />
            <small>Runs only the cases that carry every tag. Separate tags with commas.</small>
          </label>
          <label className="field">
            Concurrency
            <input
              type="number"
              min={1}
              step={1}
              value={concurrency}
              placeholder="Project default"
              onChange={(event) => setConcurrency(event.target.value)}
            />
          </label>
          <label className="field">
            Run timeout (seconds)
            <input
              type="number"
              min={1}
              step={1}
              value={timeoutSeconds}
              placeholder="Project default"
              onChange={(event) => setTimeoutSeconds(event.target.value)}
            />
          </label>
        </section>
        {startRun.error !== null ? <ErrorNotice error={startRun.error} /> : null}
        <div className="form-actions">
          <Button
            type="submit"
            tone="primary"
            disabled={selection === undefined || startRun.isPending}
          >
            {startRun.isPending ? 'Starting…' : 'Start run'}
          </Button>
        </div>
      </form>
    </Drawer>
  );
};

export { NewRunDrawer };
