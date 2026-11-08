import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DashboardSource } from '../../api/dashboard-source.js';
import { activityQueryOptions } from '../../api/queries/activity.js';
import { DailyActivity } from '../../components/charts/compact/daily-activity.js';
import { activityWindow } from '../../components/charts/compact/daily-model.js';
import { ChartGhost } from './chart-ghost.js';

type ActivityPanelProps = {
  source: DashboardSource;
  projectKey: string;
  window: { from: string; to: string };
  rangeName: string;
  hasEvals: boolean;
};

/** Passed and failed cases per UTC day across every eval of the project. */
const ActivityBody = ({ source, projectKey, window, rangeName }: ActivityPanelProps) => {
  const activity = useQuery(activityQueryOptions(source, projectKey, window));
  // Selecting a day keeps its counts in the readout. There is no per-day run list to open yet.
  const [selectedDay, setSelectedDay] = useState<string>();

  if (activity.data === undefined)
    return <ChartGhost>{activity.error?.message ?? 'Loading activity...'}</ChartGhost>;

  const covered = activityWindow(activity.data);

  if (covered === null)
    return <ChartGhost>This period has too many eval runs to count by day.</ChartGhost>;

  if (activity.data.days.length === 0)
    return <ChartGhost>No runs in the last {rangeName}.</ChartGhost>;

  return (
    <>
      <DailyActivity
        key={JSON.stringify([source.id, projectKey, covered.from, covered.to])}
        days={activity.data.days}
        window={covered}
        selectedDay={selectedDay}
        onSelectDay={setSelectedDay}
      />
      {activity.data.truncated && (
        <p className="attest-panel-note">
          Days before {covered.from} are left out: the period has too many eval runs to count.
        </p>
      )}
    </>
  );
};

const ActivityPanel = (props: ActivityPanelProps) => (
  <section className="attest-panel" aria-label="Cases per day">
    <div className="attest-panel-h">
      <h2>Cases per day</h2>
      <span className="attest-dim">All evals, UTC</span>
    </div>
    <div className="attest-panel-b">
      {props.hasEvals ? (
        <ActivityBody {...props} />
      ) : (
        <ChartGhost>Passed and failed cases per day appear here once runs exist.</ChartGhost>
      )}
    </div>
  </section>
);

export { ActivityPanel };
