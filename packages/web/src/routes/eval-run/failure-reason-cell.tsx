import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDashboardSource } from '../../api/api-client-context.js';
import { caseRecordQueryOptions } from '../../api/queries/runs.js';
import type { CaseIdentity } from '../../api/query-keys.js';
import { failureReason } from './failure-reason.js';

/**
 * A failed case's reason. Summaries carry no reason, so the row reads its own record, and only
 * once the row scrolls into view: the page never fetches every failed record up front.
 */
const FailureReasonCell = ({
  projectKey,
  identity,
}: {
  projectKey: string;
  identity: CaseIdentity;
}) => {
  const source = useDashboardSource();
  const cell = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = cell.current;

    if (element === null) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const record = useQuery({
    ...caseRecordQueryOptions(source, projectKey, identity),
    enabled: visible,
  });

  const reason =
    record.data === undefined
      ? record.error === null
        ? ''
        : 'The reason could not be loaded.'
      : failureReason(record.data);

  return (
    <span ref={cell} className="attest-why" title={reason}>
      {reason}
    </span>
  );
};

export { FailureReasonCell };
