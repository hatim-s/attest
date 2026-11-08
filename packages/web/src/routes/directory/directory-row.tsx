import { Link } from '@tanstack/react-router';
import type { ProjectOverviewEntry } from '@attest/api/contract';
import { StatusMark } from '../../components/marks/status-mark.js';
import { formatStarted } from '../../lib/format.js';
import { projectStatus } from './directory-status.js';

const Chevron = () => (
  <svg viewBox="0 0 16 16">
    <path d="M6 3.5 10.5 8 6 12.5" />
  </svg>
);

/**
 * One project. A store that cannot be read shows its error in place of the counts and has no
 * link, because its project page would only repeat the same error.
 */
const DirectoryRow = ({ entry }: { entry: ProjectOverviewEntry }) => {
  if (entry.status === 'error') {
    return (
      <tr>
        <td>
          <span className="attest-rowlink" title={entry.project.root}>
            {entry.project.name}
          </span>
        </td>
        <td colSpan={3} className="attest-hot">
          {entry.error.message}
        </td>
        <td className="attest-go" />
      </tr>
    );
  }

  const { evals, lastRunAt } = entry.overview;
  const status = projectStatus(entry.overview);

  return (
    <tr>
      <td>
        <Link
          className="attest-rowlink"
          to="/projects/$projectKey"
          params={{ projectKey: entry.project.key }}
          title={entry.project.root}
        >
          {entry.project.name}
        </Link>
      </td>
      <td className="attest-num attest-hide-narrow">
        {evals.items.length}
        {evals.nextCursor === undefined ? '' : '+'}
      </td>
      <td className="attest-nw">
        <span className="attest-status" data-tone={status.tone}>
          {status.tone !== 'none' && <StatusMark tone={status.tone} />}
          {status.text}
        </span>
      </td>
      <td className="attest-nw attest-dim attest-hide-narrow">
        {lastRunAt === null ? '' : formatStarted(lastRunAt)}
      </td>
      <td className="attest-go" aria-hidden="true">
        <Chevron />
      </td>
    </tr>
  );
};

export { DirectoryRow };
