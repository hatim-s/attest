import { useMemo, useState } from 'react';
import { createTraceWaterfall, type CaseTrace } from '../../components/traces/trace-waterfall.js';
import { JsonBlock } from '../../components/values/json-block.js';
import { formatDuration } from '../../lib/format.js';

/**
 * The case's trace as steps: name, duration and a bar on one timeline. Only an error gets a
 * status word. Each step opens to its kind, start, attributes, input and output; failed steps
 * start open, and one toggle opens or closes them all.
 */
const CaseSteps = ({ trace }: { trace: CaseTrace }) => {
  const layout = useMemo(() => createTraceWaterfall(trace), [trace]);
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());

  if (layout.rows.length === 0) return <p className="attest-dim">No steps recorded.</p>;

  const isOpen = (spanId: string, status: string) => open.get(spanId) ?? status === 'error';
  const allOpen = layout.rows.every((row) => isOpen(row.spanId, row.status));

  return (
    <>
      <div className="attest-steps-tools">
        <span className="attest-dim">
          {layout.rows.length} spans, {formatDuration(layout.durationMs)}
        </span>
        <button
          type="button"
          className="attest-mini-btn"
          onClick={() => setOpen(new Map(layout.rows.map((row) => [row.spanId, !allOpen])))}
        >
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      <ul className="attest-steps" aria-label="Steps of this case">
        {layout.rows.map((row) => {
          const expanded = isOpen(row.spanId, row.status);

          return (
            <li key={row.spanId} data-status={row.status}>
              <div className="attest-step-row">
                <button
                  type="button"
                  className="attest-step-btn"
                  aria-expanded={expanded}
                  style={{ paddingLeft: Math.min(row.depth, 6) * 16 }}
                  onClick={() => setOpen(new Map(open).set(row.spanId, !expanded))}
                >
                  <i className="attest-caret" aria-hidden="true" />
                  <code>{row.name}</code>
                  {row.status === 'error' && <span className="attest-hot">Error</span>}
                </button>
                <span className="attest-num">{formatDuration(row.durationMs)}</span>
                <span className="attest-step-tl" aria-hidden="true">
                  <i style={{ left: `${row.offsetPercent}%`, width: `${row.widthPercent}%` }} />
                </span>
              </div>
              {expanded && (
                <div className="attest-step-detail">
                  {row.span.status.message !== undefined && (
                    <p className={row.status === 'error' ? 'attest-hot' : undefined}>
                      {row.span.status.message}
                    </p>
                  )}
                  <dl className="attest-attrs">
                    <div>
                      <dt>kind</dt>
                      <dd>{row.kind}</dd>
                    </div>
                    <div>
                      <dt>start</dt>
                      <dd>+{formatDuration(row.startTime - layout.startTime)}</dd>
                    </div>
                    {Object.entries(row.span.attributes ?? {}).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  {row.span.input !== undefined && (
                    <JsonBlock
                      label={`${row.name} input`}
                      text={JSON.stringify(row.span.input, null, 2)}
                    />
                  )}
                  {row.span.output !== undefined && (
                    <JsonBlock
                      label={`${row.name} output`}
                      text={JSON.stringify(row.span.output, null, 2)}
                    />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
};

export { CaseSteps };
