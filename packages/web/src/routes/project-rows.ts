import type { RunPage } from '@attest/core/records';

/**
 * Orders projects by their newest run, newest first. A project with no runs, or whose runs have
 * not loaded, goes last; ties keep catalog order because `Array.prototype.sort` is stable.
 */
const sortByLatestRun = <Row extends { page: RunPage | undefined }>(rows: readonly Row[]): Row[] =>
  [...rows].sort((a, b) => {
    const aLatest = a.page?.items[0]?.createdAt;
    const bLatest = b.page?.items[0]?.createdAt;

    if (aLatest === undefined || bLatest === undefined) {
      return Number(aLatest === undefined) - Number(bLatest === undefined);
    }

    // Stored timestamps may or may not carry fractional seconds, so compare instants, not strings.
    return Date.parse(bLatest) - Date.parse(aLatest);
  });

/** Counts the runs on the newest page; a page with a cursor has more behind it, so it reads `100+`. */
const formatPageRunCount = (page: RunPage): string =>
  page.nextCursor === undefined ? String(page.items.length) : `${page.items.length}+`;

export { formatPageRunCount, sortByLatestRun };
