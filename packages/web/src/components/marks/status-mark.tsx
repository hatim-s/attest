type StatusTone = 'failing' | 'passing' | 'skipped' | 'running' | 'stopped' | 'run-failed';

/**
 * A square for a verdict, a circle for a lifecycle state. It is decorative: the caller always
 * prints the words next to it.
 */
const StatusMark = ({ tone }: { tone: StatusTone }) => (
  <i className="attest-mark" data-tone={tone} aria-hidden="true" />
);

export { StatusMark, type StatusTone };
