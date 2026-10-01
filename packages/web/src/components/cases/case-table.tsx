import { useRef } from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';

import type { CaseSummary } from '../../api/types.js';
import { formatDuration } from '../../lib/format.js';
import { Badge, Button, Loading } from '../shared/ui.js';

type CaseTableProps = {
  cases: CaseSummary[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onSelect: (item: CaseSummary) => void;
};

const headers = ['Case', 'Suite', 'Verdict', 'Duration', 'Metrics'];

/** Renders the paged case list with row virtualization. */
const CaseTable = ({
  cases,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onSelect,
}: CaseTableProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: cases.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    overscan: 10,
  });

  return (
    <div className="case-table-frame">
      <div className="case-table-header" role="row">
        {headers.map((header) => (
          <div key={header} role="columnheader">
            {header}
          </div>
        ))}
      </div>
      <div className="case-table-scroll" ref={scrollRef} role="rowgroup">
        <div className="case-table-spacer" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = cases[virtualRow.index];
            if (item === undefined) return null;
            return (
              <button
                className="case-table-row"
                key={virtualRow.key}
                onClick={() => onSelect(item)}
                role="row"
                style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                type="button"
              >
                <span className="case-name" role="cell">
                  {item.caseId}
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
              </button>
            );
          })}
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
