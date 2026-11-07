import { allocateSlots, countsLabel, type VerdictCounts } from './proportions.js';
import './meters.css';

type ProportionMeterProps = { counts: VerdictCounts; label: string };

/** Aggregate marks encode rounded proportions and never imply case identities. */
function ProportionMeter({ counts, label }: ProportionMeterProps) {
  const segments = allocateSlots(counts);

  return (
    <span
      className="attest-meter"
      role="img"
      title={`${label}: ${countsLabel(counts)}. Rounded proportions of known counts.`}
      aria-label={`${label}: ${countsLabel(counts)}. Rounded proportions of known counts; failures and errors receive at least one mark.`}
    >
      {segments.flatMap(({ kind, slots }) =>
        Array.from({ length: slots }, (_, index) => (
          <i key={`${kind}-${index}`} className={`attest-meter-mark ${kind}`} aria-hidden="true" />
        )),
      )}
      {counts.notRun === null && !segments.every(({ slots }) => slots === 0) && (
        <span className="attest-meter-unknown">
          ? <span>remainder unknown</span>
        </span>
      )}
      {segments.every(({ slots }) => slots === 0) && (
        <span aria-hidden="true">
          {counts.notRun === null ? 'No recorded cases; not-run count unknown' : 'No cases'}
        </span>
      )}
    </span>
  );
}

export { ProportionMeter, type ProportionMeterProps };
