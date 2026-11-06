import { useLayoutEffect, useRef, useState } from 'react';
import type { CaseVerdict } from '@attest/core/records';
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
  const [focusedId, setFocusedId] = useState<string>();
  const activeId = visible.find((record) => record.id === focusedId)?.id ?? visible[0]?.id;
  useLayoutEffect(() => {
    if (ownsFocus.current && focusedId !== activeId)
      root.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }, [activeId, focusedId]);

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
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
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
          onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();

            const marks = Array.from(
              root.current?.querySelectorAll<HTMLElement>('[tabindex]') ?? [],
            );

            const index = marks.indexOf(event.currentTarget);

            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? marks.length - 1
                  : Math.max(
                      0,
                      Math.min(marks.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)),
                    );

            marks[next]?.focus();
          },
        };

        return record.verdict === 'not-run' ? (
          <span key={record.id} {...props} />
        ) : (
          <a key={record.id} href={record.href} {...props} />
        );
      })}
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
