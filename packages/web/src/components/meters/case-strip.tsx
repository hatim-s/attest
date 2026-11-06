import type { CaseVerdict } from '@attest/core/records';
import './meters.css';

type CaseStripRecord = {
  id: string;
  label: string;
  verdict: CaseVerdict | 'skipped' | 'not-run';
  href: string;
};

type CaseStripProps = { records: readonly CaseStripRecord[]; label: string };

const EXACT_STRIP_LIMIT = 40;

/** Links represent only supplied identities, in the caller's real record order. */
function CaseStrip({ records, label }: CaseStripProps) {
  return (
    <span className="attest-case-strip" role="group" aria-label={label}>
      {records.slice(0, EXACT_STRIP_LIMIT).map((record) => (
        <a
          key={record.id}
          className={`attest-meter-mark ${record.verdict}`}
          href={record.href}
          aria-label={`${record.label}: ${record.verdict}`}
          title={`${record.label}: ${record.verdict}`}
        />
      ))}
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
