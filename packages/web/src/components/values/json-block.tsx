/** Recorded evidence as text the caller already serialised, in a scrollable monospace block. */
const JsonBlock = ({ text, label }: { text: string; label: string }) => (
  <pre className="attest-json" aria-label={label} tabIndex={0}>
    {text}
  </pre>
);

export { JsonBlock };
