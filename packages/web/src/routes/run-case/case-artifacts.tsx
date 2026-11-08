import type { InlineArtifact } from '@attest/core/records';

/** Text previews stop here so one large file cannot push the rest of the page away. */
const PREVIEW_LIMIT_BYTES = 64 * 1024;

/**
 * Counts the decoded bytes of an artifact. Base64 is sized from its length without decoding,
 * which is exact for canonical base64 (padded, no whitespace), the only form agents emit.
 */
const artifactBytes = ({ content, encoding }: InlineArtifact): number => {
  if (encoding === 'utf8') return new TextEncoder().encode(content).byteLength;

  const unpaddedLength = content.replace(/=+$/u, '').length;

  return Math.floor((unpaddedLength * 3) / 4);
};

/**
 * "Artifacts N", closed by default: each file's path, media type and size, with a preview for
 * small utf8 files. Base64 and large files show their size only.
 */
const CaseArtifacts = ({ artifacts }: { artifacts: readonly InlineArtifact[] }) => (
  <details className="attest-disc">
    <summary>
      Artifacts <span className="attest-dim">{artifacts.length}</span>
    </summary>
    <ul className="attest-disc-b attest-arts">
      {artifacts.map((artifact) => {
        const bytes = artifactBytes(artifact);

        return (
          <li key={artifact.path}>
            <code>{artifact.path}</code>
            <span className="attest-dim">
              {artifact.media_type}, {bytes} B
            </span>
            {artifact.encoding === 'utf8' && bytes < PREVIEW_LIMIT_BYTES && (
              <details>
                <summary>Preview</summary>
                <pre className="attest-json">{artifact.content}</pre>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  </details>
);

export { CaseArtifacts };
