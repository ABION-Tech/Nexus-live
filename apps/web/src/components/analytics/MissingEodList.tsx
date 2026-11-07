import { Avatar } from '../ui/Avatar';
import { EmptyState } from '../ui/EmptyState';
import type { MissingEodUser } from '@nexus/shared';

export interface MissingEodListProps {
  users: MissingEodUser[];
}

// Tier 2 (PRD §7.2 07 ANALYTICS "Missing EOD" subsection; §8.9 Failsafe's
// `eod` category). Deliberately its own small component rather than
// reusing FailsafeTable — the underlying row shape (MissingEodUser: just
// who hasn't filed) isn't a Task, so forcing it through FailsafeTable's
// Task-shaped columns would mean fake/empty status+deadline cells for a
// list that doesn't have either.
export function MissingEodList({ users }: MissingEodListProps) {
  if (users.length === 0) {
    return <EmptyState title="Everyone's filed" description="No missing EODs for this day." />;
  }

  return (
    <ul className="nx-missing-eod">
      {users.map((u) => (
        <li key={u.userId} className="nx-missing-eod__item">
          <Avatar name={u.name} size="sm" />
          <span>{u.name}</span>
        </li>
      ))}
    </ul>
  );
}
