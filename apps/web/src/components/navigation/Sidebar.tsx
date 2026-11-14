import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { IA, type IaSection } from '../../app/ia';
import { NAV, navPaths } from '../../app/nav';
import type { CurrentUser } from '../../services/authService';
import { navIcon } from './sectionIcons';
import { Logo } from './Logo';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { useNavCounts } from './NavCounts';

export interface SidebarProps {
  user: CurrentUser;
  /** Phone layout only: whether the drawer is showing. */
  open?: boolean;
  onClose?: () => void;
  /** Phone layout only: account controls that live in the top bar on
   * wider screens. */
  footer?: ReactNode;
}

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

// Session 58 — flat, grouped sidebar with live counts, as in the original
// HTML app (every screen one click away). Session 55: on phones this is a
// slide-in drawer. Session 57: the company switcher under the logo.
export function Sidebar({ user, open = false, onClose, footer }: SidebarProps) {
  const { pathname } = useLocation();
  const counts = useNavCounts();

  // The active item is the longest menu path the current page sits under.
  const active = navPaths()
    .filter((p) => pathname === p || pathname.startsWith(p + '/'))
    .sort((a, b) => b.length - a.length)[0];
  const linked = new Set(navPaths());
  const seen = new Set<string>();

  return (
    <nav className={'nx-sidebar' + (open ? ' nx-sidebar--open' : '')} aria-label="Primary" id="nx-sidebar">
      <div className="nx-sidebar__brand">
        <Logo size={19} />
        <button type="button" className="nx-sidebar__close" onClick={onClose} aria-label="Close menu">
          ✕
        </button>
      </div>
      <WorkspaceSwitcher disabled={Boolean(user.impersonatedBy)} />
      <div className="nx-nav">
        {NAV.map((group) => {
          const items = group.items
            .map((item) => ({ item, hit: resolve(item.path, item.section, user) }))
            .filter(({ item, hit }) => {
              if (!hit) return false;
              const k = item.path; // Group and Company Admin share /admin: show one
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            });
          if (items.length === 0) return null;
          return (
            <div key={group.label} className="nx-nav__group">
              <div className="nx-nav__label">{group.label}</div>
              <ul>
                {items.map(({ item, hit }) => {
                  const Icon = navIcon(item.icon);
                  const isActive = active === item.path;
                  const n = item.count && counts ? counts[item.count] : 0;
                  const children =
                    item.section && (isActive || hit!.section.subsections.some((s) => s.path === pathname))
                      ? hit!.section.subsections.filter((s) => s.built && s.path !== item.path && !linked.has(s.path))
                      : [];
                  return (
                    <li key={item.path}>
                      <NavLink to={item.path} end className={'nx-nav__link' + (isActive ? ' nx-nav__link--active' : '')}>
                        <Icon className="nx-nav__icon" size={16} strokeWidth={2} aria-hidden="true" />
                        <span className="nx-nav__text">{item.label}</span>
                        {n > 0 && <span className={`nx-nav__count nx-nav__count--${item.tone ?? 'accent'}`}>{n}</span>}
                      </NavLink>
                      {children.length > 0 && (
                        <ul className="nx-nav__sub">
                          {children.map((s) => (
                            <li key={s.path}>
                              <NavLink to={s.path} end className={({ isActive: a }) => 'nx-nav__sublink' + (a ? ' nx-nav__sublink--active' : '')}>
                                {s.label}
                              </NavLink>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      {footer && <div className="nx-sidebar__footer">{footer}</div>}
    </nav>
  );
}
