// Session 61 — phones: the four places people go most, one thumb away at
// the bottom of the screen, plus "More" for the full menu (the sidebar as
// a sheet). Each tab shows its live count as a small badge when it needs
// action. Hidden above 700px, where the sidebar is always there.
import { NavLink } from 'react-router-dom';
import { CheckSquare, Clock, LayoutDashboard, Menu, UserCheck } from 'lucide-react';
import type { CurrentUser } from '../../services/authService';
import { useNavCounts } from './NavCounts';
import { useNavModel } from './navModel';

const TABS = [
  { path: '/dashboard', label: 'Home', Icon: LayoutDashboard },
  { path: '/work/team-tasks', label: 'Tasks', Icon: CheckSquare },
  { path: '/work/my-tasks', label: 'Mine', Icon: UserCheck },
  { path: '/work/follow-ups', label: 'Follow-ups', Icon: Clock, count: 'followUps' as const },
];

export function MobileTabBar({ user, onMore, moreOpen }: { user: CurrentUser; onMore: () => void; moreOpen: boolean }) {
  const { groups, active } = useNavModel(user);
  const counts = useNavCounts();
  const reachable = new Set(groups.flatMap((g) => g.items.map((i) => i.path)));
  const tabs = TABS.filter((t) => reachable.has(t.path));
  const inTabs = tabs.some((t) => t.path === active);

  return (
    <nav className="nx-tabbar" aria-label="Main">
      {tabs.map(({ path, label, Icon, count }) => {
        const on = active === path && !moreOpen;
        const n = count && counts ? counts[count] : 0;
        return (
          <NavLink key={path} to={path} end className={'nx-tabbar__tab' + (on ? ' is-on' : '')} aria-current={on ? 'page' : undefined}>
            <span className="nx-tabbar__icon">
              <Icon size={20} strokeWidth={on ? 2.4 : 2} aria-hidden="true" />
              {n > 0 && <span className="nx-tabbar__badge">{n > 99 ? '99+' : n}</span>}
            </span>
            <span className="nx-tabbar__label">{label}</span>
          </NavLink>
        );
      })}
      <button
        type="button"
        className={'nx-tabbar__tab' + (moreOpen || (!inTabs && active) ? ' is-on' : '')}
        onClick={onMore}
        aria-expanded={moreOpen}
        aria-controls="nx-sidebar"
      >
        <span className="nx-tabbar__icon">
          <Menu size={20} strokeWidth={2} aria-hidden="true" />
        </span>
        <span className="nx-tabbar__label">More</span>
      </button>
    </nav>
  );
}
