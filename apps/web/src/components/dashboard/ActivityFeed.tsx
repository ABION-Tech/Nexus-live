import { Avatar } from '../ui/Avatar';
import { EmptyState } from '../ui/EmptyState';

// Local shape, not @nexus/shared — no route returns this yet (Dashboard is
// still API-service-less, see modules/dashboard/Overview.tsx). Promote to
// shared only once a real "recent activity" endpoint needs the same type,
// per the shared-types rule in packages/shared/src/index.ts.
export interface ActivityItem {
  id: string;
  actorName: string;
  actorAvatarUrl?: string;
  message: string; // e.g. "marked \"Draft Q3 partner email\" as done"
  timestamp: string; // pre-formatted display string (e.g. "2h ago") —
  // relative-time formatting is a utils/ concern, not this component's
}

export interface ActivityFeedProps {
  items: ActivityItem[];
  emptyMessage?: string;
}

// Tier 2 (PRD §6.3, §8.1). Purely presentational — receives its list via
// props (§6.2: no direct API calls), and only owns the "no activity yet"
// empty case; loading/error around the fetch itself is the module's job.
export function ActivityFeed({ items, emptyMessage = 'No recent activity yet.' }: ActivityFeedProps) {
  if (items.length === 0) {
    return <EmptyState title="Nothing here yet" description={emptyMessage} />;
  }

  return (
    <ul className="nx-activity-feed">
      {items.map((item) => (
        <li key={item.id} className="nx-activity-feed__item">
          <Avatar name={item.actorName} src={item.actorAvatarUrl} size="sm" />
          <div className="nx-activity-feed__body">
            <span className="nx-activity-feed__text">
              <strong>{item.actorName}</strong> {item.message}
            </span>
            <span className="nx-activity-feed__time">{item.timestamp}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
