import type { InlineArtifact } from '@attest/core/records';

/** Text previews stop here so one large file cannot push the rest of the drawer off screen. */
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
 * Lists the files an agent returned with their size, and previews small utf8 files. Base64 and
 * large files show their size only.
 */
const CaseArtifacts = ({ artifacts }: { artifacts: InlineArtifact[] }) => {
  const sized = artifacts.map((artifact) => ({ artifact, bytes: artifactBytes(artifact) }));

  return (
    <>
      <div className="analytics-table-scroll">
        <table className="analytics-table" aria-label="Artifacts">
          <thead>
            <tr>
              <th scope="col">Path</th>
              <th scope="col">Media type</th>
              <th scope="col">Size (bytes)</th>
            </tr>
          </thead>
          <tbody>
            {sized.map(({ artifact, bytes }) => (
              <tr key={artifact.path}>
                <th className="mono" scope="row">
                  {artifact.path}
                </th>
                <td>{artifact.media_type}</td>
                <td>{bytes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sized
        .filter(
          ({ artifact, bytes }) => artifact.encoding === 'utf8' && bytes < PREVIEW_LIMIT_BYTES,
        )
        .map(({ artifact }) => (
          <details className="artifact-preview" key={artifact.path}>
            <summary>Preview {artifact.path}</summary>
            <pre>{artifact.content}</pre>
          </details>
        ))}
    </>
  );
};

export { CaseArtifacts };
