import { NavLink, useLocation } from 'react-router-dom';
import { IA } from '../../app/ia';
import type { CurrentUser } from '../../services/authService';
import { sectionIcon } from './sectionIcons';

export interface SidebarProps {
  user: CurrentUser;
}

// Real §7.2 sidebar — one <NavLink> tree per IA section/subsection,
// replacing App.tsx's previous manual dashboard/analytics/kitchen-sink
// toggle. permissionGated sections are hidden from non-leaders as a UX
// convenience only (see app/ia.ts's note on why this isn't the real
// authorization boundary).
//
// UI Rehaul polish pass: dropped the "01"/"02" PRD-numeral badge each
// section link used to render — internally useful for cross-referencing
// this file against §7.2 while building it, but reads as an unfinished
// spec doc rather than a product to anyone actually using the app. An
// icon per section (sectionIcons.tsx) replaces it as the at-a-glance
// anchor instead.
export function Sidebar({ user }: SidebarProps) {
  const { pathname } = useLocation();
  const isLeader = user.role === 'leader';

  return (
    <nav className="nx-sidebar" aria-label="Primary">
      <div className="nx-sidebar__brand">NEXUS</div>
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
    </nav>
  );
}
