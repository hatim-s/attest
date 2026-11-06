import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { CaseVerdict } from '@attest/core/records';
import { arrowIndex } from '../charts/compact/chart-keyboard.js';
import './meters.css';

type CaseStripRecord = { id: string; label: string } & (
  { verdict: CaseVerdict | 'skipped'; href: string } | { verdict: 'not-run'; href?: never }
);

type CaseStripProps = { records: readonly CaseStripRecord[]; label: string };

const EXACT_STRIP_LIMIT = 40;

/** One tab stop explores actual case records; unrecorded cases never fabricate trace links. */
function CaseStrip({ records, label }: CaseStripProps) {
  const visible = records.slice(0, EXACT_STRIP_LIMIT);
  const root = useRef<HTMLSpanElement>(null);
  const ownsFocus = useRef(false);
  const pendingRecovery = useRef(false);
  const nodes = useRef(new Map<string, HTMLAnchorElement>());
  const [focusedId, setFocusedId] = useState<string>();
  const activeId = visible.find((record) => record.id === focusedId)?.id ?? visible[0]?.id;
  useLayoutEffect(() => {
    // Ref detachment observes focus before React removes a node. An explicit blur revokes it.
    if (pendingRecovery.current && ownsFocus.current && document.activeElement === document.body)
      root.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
    pendingRecovery.current = false;
  });

  return (
    <span
      ref={root}
      className="attest-case-strip"
      role="group"
      aria-label={label}
      onFocus={() => {
        ownsFocus.current = true;
      }}
      onBlur={(event) => {
        if (
          !event.currentTarget.contains(event.relatedTarget) &&
          (event.relatedTarget !== null || !pendingRecovery.current)
        )
          ownsFocus.current = false;
      }}
    >
      {visible.map((record) => {
        const props = {
          className: `attest-meter-mark ${record.verdict}`,
          tabIndex: activeId === record.id ? 0 : -1,
          'aria-label': `${record.label}: ${record.verdict}${record.verdict === 'not-run' ? ', no recorded result' : ''}`,
          title: `${record.label}: ${record.verdict}`,
          onFocus: () => setFocusedId(record.id),
          onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();

            const marks = Array.from(
              root.current?.querySelectorAll<HTMLElement>('[tabindex]') ?? [],
            );

            const index = marks.indexOf(event.currentTarget);

            const next = arrowIndex(event.key, index, marks.length);

            marks[next]?.focus();
          },
        };

        return (
          <a
            key={record.id}
            ref={(node) => {
              const previous = nodes.current.get(record.id);

              if (!node && previous === document.activeElement && ownsFocus.current)
                pendingRecovery.current = true;

              if (node) nodes.current.set(record.id, node);
              else nodes.current.delete(record.id);
            }}
            href={record.verdict === 'not-run' ? undefined : record.href}
            role={record.verdict === 'not-run' ? 'img' : undefined}
            {...props}
          />
        );
      })}
      {records.length > 0 && (
        <span className="attest-strip-key">
          Solid: passed. Capped orange: failed. Outline: error. Striped: skipped result. Dotted: no
          recorded result.
        </span>
      )}
      {records.length === 0 && <span>No records</span>}
      {records.length > EXACT_STRIP_LIMIT && (
        <span>
          Showing {EXACT_STRIP_LIMIT} of {records.length}
        </span>
      )}
    </span>
  );
}

export { CaseStrip, EXACT_STRIP_LIMIT, type CaseStripRecord, type CaseStripProps };
