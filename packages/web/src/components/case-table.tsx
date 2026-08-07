import { useMemo, useRef } from 'react';

import {
  getCoreRowModel,
  legacyCreateColumnHelper,
  useLegacyTable,
} from '@tanstack/react-table/legacy';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { CaseSummary } from '../api/types.js';
import { formatDuration } from '../lib/format.js';
import { Badge, Button, Loading } from './ui.js';

type CaseTableProps = {
  cases: CaseSummary[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onSelect: (item: CaseSummary) => void;
};

const columnHelper = legacyCreateColumnHelper<CaseSummary>();

/** Renders the paged case projection using TanStack Table and row virtualization. */
const CaseTable = ({
  cases,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onSelect,
}: CaseTableProps) => {
  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor('caseId', { header: 'Case' }),
        columnHelper.accessor('suiteName', { header: 'Suite' }),
        columnHelper.accessor('verdict', { header: 'Verdict' }),
        columnHelper.accessor('durationMs', { header: 'Duration' }),
        columnHelper.accessor((item) => item.metricCounts, { id: 'metrics', header: 'Metrics' }),
      ]),
    [],
  );
  const table = useLegacyTable({ columns, data: cases, getCoreRowModel: getCoreRowModel() });
  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    overscan: 10,
  });

  return (
    <div className="case-table-frame">
      <div className="case-table-header" role="row">
        {table.getFlatHeaders().map((header) => (
          <div key={header.id} role="columnheader">
            {String(header.column.columnDef.header ?? '')}
          </div>
        ))}
      </div>
      <div className="case-table-scroll" ref={scrollRef} role="rowgroup">
        <div className="case-table-spacer" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (row === undefined) return null;
            const item = row.original;
            return (
              <Button
                className="case-table-row"
                key={row.id}
                onClick={() => onSelect(item)}
                role="row"
                style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                tone="ghost"
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
              </Button>
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
