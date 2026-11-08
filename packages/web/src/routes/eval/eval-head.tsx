import { Link } from '@tanstack/react-router';
import { NewRunButton } from '../new-run/new-run-button.js';

type EvalHeadProps = { projectKey: string; suiteName: string; tab: 'runs' | 'cases' };

/** The eval's title, its New run control and the Runs and Test cases tabs. */
const EvalHead = ({ projectKey, suiteName, tab }: EvalHeadProps) => (
  <>
    <div className="attest-page-head">
      <div className="attest-page-title">
        <h1>{suiteName}</h1>
      </div>
      <div className="attest-page-end">
        <NewRunButton projectKey={projectKey} suiteName={suiteName} />
      </div>
    </div>
    <nav className="attest-tabs" aria-label={`${suiteName} views`}>
      <Link
        to="/projects/$projectKey/evals/$suiteName/runs"
        params={{ projectKey, suiteName }}
        search={(previous) => ({ x: previous.x ?? 'run' })}
        aria-current={tab === 'runs' ? 'page' : undefined}
      >
        Runs
      </Link>
      <Link
        to="/projects/$projectKey/evals/$suiteName/cases"
        params={{ projectKey, suiteName }}
        search={{ filter: 'all' }}
        aria-current={tab === 'cases' ? 'page' : undefined}
      >
        Test cases
      </Link>
    </nav>
  </>
);

export { EvalHead };
