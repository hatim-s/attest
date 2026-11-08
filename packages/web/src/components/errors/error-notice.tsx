import { ApiError } from '@attest/api/client';
import '../../styles/compact/controls.css';

/**
 * A failed request in the Compact style: its message, then what the CLI or project loader
 * reported when the API sent diagnostics.
 */
const ErrorNotice = ({ error }: { error: Error }) => {
  const diagnostics = error instanceof ApiError ? error.details : undefined;

  return (
    <div className="attest-error" role="alert">
      <p>{error.message}</p>
      {diagnostics !== undefined && (
        <dl>
          <dt>Code</dt>
          <dd>
            <code>{diagnostics.code}</code>
          </dd>
          {diagnostics.path !== undefined && (
            <>
              <dt>Path</dt>
              <dd>
                <code>{diagnostics.path}</code>
              </dd>
            </>
          )}
          {diagnostics.hint !== undefined && (
            <>
              <dt>Hint</dt>
              <dd>{diagnostics.hint}</dd>
            </>
          )}
          {diagnostics.details !== undefined && (
            <>
              <dt>Details</dt>
              <dd>
                <pre>{JSON.stringify(diagnostics.details, null, 2)}</pre>
              </dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
};

export { ErrorNotice };
