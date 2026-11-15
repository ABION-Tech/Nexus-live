// Session 61 — one model of "what this person can reach, and where they
// are", shared by the sidebar, the command palette (⌘K) and the phone tab
// bar, so the three can never disagree. The routes and who may see them
// still come from ia.ts; the menu layout from nav.ts.
import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { IA, type IaSection } from '../../app/ia';
import { NAV, navPaths, type NavItem } from '../../app/nav';
import type { CurrentUser } from '../../services/authService';

function sectionVisible(section: IaSection, user: CurrentUser): boolean {
  if (section.permissionGated && user.role !== 'leader') return false;
  if (section.adminGate === 'group' && !user.isGroupAdmin) return false;
  if (section.adminGate === 'company' && !user.isCompanyAdmin) return false;
  if (section.adminGate === 'platform' && !user.isPlatformAdmin) return false;
  return true;
}

/** The IA section + subsection an item points at, if this person may see it. */
function resolve(path: string, sectionId: string | undefined, user: CurrentUser) {
  const sections = sectionId ? IA.filter((s) => s.id === sectionId) : IA;
  for (const s of sections) {
    const sub = s.subsections.find((x) => x.path === path);
    if (sub) return sub.built && sectionVisible(s, user) ? { section: s, sub } : null;
  }
  return null;
}

export interface VisibleItem extends NavItem {
  /** Other pages of the same IA section, listed under the item when open. */
  children: { label: string; path: string }[];
}

export interface VisibleGroup {
  label: string;
  items: VisibleItem[];
}

/** The menu this person can see. */
export function visibleNav(user: CurrentUser): VisibleGroup[] {
  const linked = new Set(navPaths());
  const seen = new Set<string>();
  const groups: VisibleGroup[] = [];
  for (const group of NAV) {
    const items: VisibleItem[] = [];
    for (const item of group.items) {
      const hit = resolve(item.path, item.section, user);
      if (!hit || seen.has(item.path)) continue; // Group and Company Admin share /admin: show one
      seen.add(item.path);
      const children = item.section
        ? hit.section.subsections.filter((s) => s.built && s.path !== item.path && !linked.has(s.path)).map((s) => ({ label: s.label, path: s.path }))
        : [];
      items.push({ ...item, children });
    }
    if (items.length) groups.push({ label: group.label, items });
  }
  return groups;
}

/** The longest menu path the current page sits under (the active item). */
export function activePathFor(pathname: string, groups: VisibleGroup[]): string | undefined {
  const paths = groups.flatMap((g) => g.items.flatMap((i) => [i.path, ...i.children.map((c) => c.path)]));
  const hit = paths.filter((p) => pathname === p || pathname.startsWith(p + '/')).sort((a, b) => b.length - a.length)[0];
  if (!hit) return undefined;
  // A child page highlights its parent item.
  for (const g of groups) for (const i of g.items) if (i.path === hit || i.children.some((c) => c.path === hit)) return i.path;
  return hit;
}

export function useNavModel(user: CurrentUser) {
  const { pathname } = useLocation();
  const groups = useMemo(() => visibleNav(user), [user]);
  const active = activePathFor(pathname, groups);
  return { groups, active, pathname };
}
