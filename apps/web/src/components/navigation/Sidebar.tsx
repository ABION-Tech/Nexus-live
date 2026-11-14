import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { IA } from '../../app/ia';
import type { CurrentUser } from '../../services/authService';
import { sectionIcon } from './sectionIcons';
import { Logo } from './Logo';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

export interface SidebarProps {
  user: CurrentUser;
  /** Phone layout only: whether the drawer is showing. Ignored on wider
   * screens, where the sidebar is always in place. */
  open?: boolean;
  onClose?: () => void;
  /** Phone layout only: account controls (theme, sign out) that live in the
   * top bar on wider screens — same idea as the original HTML app's
   * #sidebar-utils strip. */
  footer?: ReactNode;
}

// Real §7.2 sidebar — one <NavLink> tree per IA section/subsection.
// permissionGated sections are hidden from non-leaders as a UX
// convenience only (see app/ia.ts's note on why this isn't the real
// authorization boundary).
//
// Session 55: on phones (≤ 700px) this becomes a slide-in drawer opened
// from the ☰ button in the top bar, the way the original HTML app worked,
// instead of permanently taking half the screen.
export function Sidebar({ user, open = false, onClose, footer }: SidebarProps) {
  const { pathname } = useLocation();
  const isLeader = user.role === 'leader';

  return (
    <nav className={'nx-sidebar' + (open ? ' nx-sidebar--open' : '')} aria-label="Primary" id="nx-sidebar">
      <div className="nx-sidebar__brand">
        <Logo size={19} />
        <button type="button" className="nx-sidebar__close" onClick={onClose} aria-label="Close menu">
          ✕
        </button>
      </div>
      {/* Session 57 — which company you're in; switch to another. */}
      <WorkspaceSwitcher disabled={Boolean(user.impersonatedBy)} />
      <ul className="nx-sidebar__sections">
        {IA.filter((section) => !section.permissionGated || isLeader).map((section) => {
          const sectionActive = pathname === section.path || pathname.startsWith(section.path + '/');
          const Icon = sectionIcon(section.id);
          return (
            <li key={section.id} className="nx-sidebar__section">
              <NavLink
                to={section.path}
                className={() => 'nx-sidebar__section-link' + (sectionActive ? ' nx-sidebar__section-link--active' : '')}
              >
                <Icon className="nx-sidebar__section-icon" size={17} strokeWidth={2} aria-hidden="true" />
                <span className="nx-sidebar__section-label">{section.label}</span>
              </NavLink>
              {sectionActive && section.subsections.length > 1 && (
                <ul className="nx-sidebar__subsections">
                  {section.subsections.map((sub) => (
                    <li key={sub.id}>
                      <NavLink
                        to={sub.path}
                        end
                        className={({ isActive }) =>
                          'nx-sidebar__sub-link' + (isActive ? ' nx-sidebar__sub-link--active' : '') + (!sub.built ? ' nx-sidebar__sub-link--stub' : '')
                        }
                      >
                        {sub.label}
                        {!sub.built && <span className="nx-sidebar__stub-dot" title="Not built yet" />}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {footer && <div className="nx-sidebar__footer">{footer}</div>}
    </nav>
  );
}
