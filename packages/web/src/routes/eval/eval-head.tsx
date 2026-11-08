import { Link } from '@tanstack/react-router';

/**
 * The eval's title and the two tab labels. The Test cases view is not built
 * yet, so its tab is shown disabled rather than linking to a page that does not exist.
 */
const EvalHead = ({ projectKey, suiteName }: { projectKey: string; suiteName: string }) => (
  <>
    <div className="attest-page-head">
      <div className="attest-page-title">
        <h1>{suiteName}</h1>
      </div>
    </div>
    <nav className="attest-tabs" aria-label={`${suiteName} views`}>
      <Link
        to="/projects/$projectKey/evals/$suiteName/runs"
        params={{ projectKey, suiteName }}
        search={(previous) => ({ x: previous.x ?? 'run' })}
        aria-current="page"
      >
        Runs
      </Link>
      <span aria-disabled="true">Test cases</span>
    </nav>
  </>
);

export { EvalHead };
