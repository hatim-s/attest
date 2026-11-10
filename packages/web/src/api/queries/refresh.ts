import { isLiveSource, type DashboardSource } from '../dashboard-source.js';

const RUNNING_POLL_MS = 5_000;

const RUN_POLL_MS = 2_000;

/** Idle reads refetch on window focus once they are this old. */
const IDLE_STALE_MS = 30_000;

/**
 * Refresh policy for live reads: poll every 5 s while a run executes, otherwise refetch on focus
 * after 30 s. A snapshot never changes, so it never polls and never goes stale.
 */
const refreshPolicy = (
  source: DashboardSource,
  running: boolean,
): { staleTime: number; refetchInterval: number | false } =>
  isLiveSource(source)
    ? { staleTime: IDLE_STALE_MS, refetchInterval: running ? RUNNING_POLL_MS : false }
    : { staleTime: Infinity, refetchInterval: false };

const runRefetchInterval = (source: DashboardSource, running: boolean): number | false =>
  isLiveSource(source) && running ? RUN_POLL_MS : false;

export { refreshPolicy, runRefetchInterval };
