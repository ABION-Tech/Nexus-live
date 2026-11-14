// Session 58 — the sidebar, laid out the way the original HTML app's was:
// one flat list, grouped, every screen one click away, with live counts.
// The routes, and who may see them, still come from ia.ts (unchanged), so
// this is purely the menu: an item is shown only if ia.ts has a built
// subsection at that path that this person can reach.
import type { OverviewCounts } from '../services/overviewService';
import type { IaSection } from './ia';

export interface NavItem {
  label: string;
  path: string;
  /** Live badge from GET /overview. */
  count?: keyof OverviewCounts;
  tone?: 'accent' | 'danger' | 'warn';
  /** When this item is open, also list this IA section's other pages
   * under it (People → Team Members, Attendance …). */
  section?: string;
  /** The icon (sectionIcons.tsx). */
  icon: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { label: 'KPI Dashboard', path: '/dashboard', icon: 'dashboard' },
      { label: 'Master Tasks', path: '/work/team-tasks', count: 'activeTasks', tone: 'accent', icon: 'work' },
      { label: 'My Tasks', path: '/work/my-tasks', icon: 'my-tasks' },
      { label: 'All my companies', path: '/work/all', icon: 'companies' },
      { label: 'Projects', path: '/work/projects', icon: 'projects' },
      { label: 'Goals', path: '/goals', icon: 'goals' },
      { label: 'Review Queue', path: '/goals/review-queue', count: 'reviewPending', tone: 'accent', icon: 'review' },
    ],
  },
  {
    label: 'Network',
    items: [
      { label: 'Network', path: '/network/state', icon: 'network' },
      { label: 'Partnerships', path: '/network/partnerships', icon: 'partners' },
      { label: 'Org Database', path: '/network/org-database', icon: 'org' },
    ],
  },
  {
    label: 'Ops',
    items: [
      { label: 'EOD Report', path: '/comms-ops', icon: 'eod' },
      { label: 'Activity Log', path: '/comms-ops/activity', icon: 'activity' },
      { label: 'Calendar', path: '/work/calendar', icon: 'calendar' },
      { label: 'Meetings', path: '/comms-ops/meetings', count: 'upcomingMeetings', tone: 'accent', icon: 'meetings' },
      { label: 'Follow-Ups', path: '/work/follow-ups', count: 'followUps', tone: 'danger', icon: 'follow-ups' },
      { label: 'Failsafe Alerts', path: '/comms-ops/failsafe-alerts', count: 'failsafe', tone: 'danger', icon: 'failsafe' },
      { label: 'Marketing', path: '/comms-ops/marketing', icon: 'marketing' },
    ],
  },
  {
    label: 'People',
    items: [
      { label: 'HR', path: '/people', section: 'people', icon: 'people' },
      { label: 'Analytics', path: '/analytics', icon: 'analytics' },
      { label: 'AI Analyst', path: '/ai-analyst', section: 'ai-analyst', icon: 'ai-analyst' },
    ],
  },
  {
    label: 'Settings',
    items: [
      { label: 'Automation', path: '/automation', section: 'automation', icon: 'automation' },
      { label: 'Knowledge Base', path: '/knowledge', section: 'knowledge', icon: 'knowledge' },
      { label: 'Settings', path: '/settings', section: 'settings', icon: 'settings' },
      { label: 'Group Admin', path: '/admin', section: 'admin-group', icon: 'admin-group' },
      { label: 'Company Admin', path: '/admin', section: 'admin-company', icon: 'admin-company' },
      { label: 'Super Admin', path: '/admin/platform', section: 'admin-platform', icon: 'admin-platform' },
    ],
  },
];

/** The IA section and subsection that own a path, if any. */
export function iaFor(sections: IaSection[], path: string) {
  for (const s of sections) {
    const sub = s.subsections.find((x) => x.path === path);
    if (sub) return { section: s, sub };
  }
  return null;
}

/** Every path the menu links to directly (to work out the active item). */
export function navPaths(): string[] {
  return NAV.flatMap((g) => g.items.map((i) => i.path));
}
