import { useRef } from 'react';
import { Link } from '@tanstack/react-router';

import { useVirtualizer } from '@tanstack/react-virtual';

import type { CaseSummary } from '@attest/core/records';
import { formatDuration } from '../../lib/format.js';
import { useProjectKey } from '../../routes/use-project-key.js';
import { Badge, Button, Loading } from '../shared/ui.js';

type CaseTableProps = {
  cases: CaseSummary[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  runId: string;
};

const headers = ['Case', 'Suite', 'Verdict', 'Duration', 'Metrics'];

/** Renders the paged case list with row virtualization. */
const CaseTable = ({
  cases,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  runId,
}: CaseTableProps) => {
  const projectKey = useProjectKey();
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: cases.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    overscan: 10,
  });

  return (
    <div className="case-table-frame">
      <div role="table" aria-label="Cases" aria-rowcount={hasNextPage ? -1 : cases.length + 1}>
        <div className="case-table-header" role="row" aria-rowindex={1}>
          {headers.map((header) => (
            <div key={header} role="columnheader">
              {header}
            </div>
          ))}
        </div>
        <div className="case-table-scroll" ref={scrollRef} role="rowgroup">
          <div
            className="case-table-spacer"
            role="presentation"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = cases[virtualRow.index];

              if (item === undefined) return null;

              return (
                <div
                  className="case-table-row"
                  key={virtualRow.key}
                  role="row"
                  aria-rowindex={virtualRow.index + 2}
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <span className="case-name" role="cell">
                    {/* The link stretches over the row, so the whole row stays clickable. */}
                    <Link
                      className="case-link"
                      to="/projects/$projectKey/runs/$runId/cases/$suiteName/$caseId"
                      params={{ projectKey, runId, suiteName: item.suiteName, caseId: item.caseId }}
                      search={(previous) => previous}
                      state={{ caseOpenedFromRun: true }}
                    >
                      {item.caseId}
                    </Link>
                  </span>
                  <span className="muted" role="cell">
                    {item.suiteName}
                  </span>
                  <span role="cell">
                    <Badge tone={item.verdict}>{item.verdict}</Badge>
                  </span>
                  <span className="mono" role="cell">
                    {formatDuration(item.durationMs)}
                  </span>
                  <span className="mono" role="cell">
                    {item.metricCounts.passed}/{item.metricCounts.expected}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {hasNextPage ? (
        <Button className="load-more" disabled={isFetchingNextPage} onClick={onLoadMore}>
          {isFetchingNextPage ? <Loading label="Loading cases" /> : 'Load more cases'}
        </Button>
      ) : null}
    </div>
  );
};

export { CaseTable, type CaseTableProps };
