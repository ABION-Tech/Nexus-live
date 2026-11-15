// Session 61 — the sidebar, rebuilt to feel like a working tool rather than
// a long flat list:
//   • groups fold open and shut (animated, remembered on this device); a
//     shut group still shows its live counts, and opening a page in a shut
//     group opens it;
//   • one highlight slides to the page you're on;
//   • on desktop it collapses to an icon rail (button or "[" key), with a
//     label tooltip on hover/focus;
//   • you, your theme and log out live in one menu at the foot;
//   • on phones it is a sheet that slides in, and can be swiped shut.
// What's in the menu, and who sees what, is unchanged (navModel.ts).
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronDown, LogOut, Moon, PanelLeftClose, PanelLeftOpen, Search, Settings as SettingsIcon, Sun, X } from 'lucide-react';
import type { CurrentUser } from '../../services/authService';
import { useTheme } from '../../app/ThemeContext';
import { Avatar } from '../ui';
import { navIcon } from './sectionIcons';
import { Logo } from './Logo';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { useNavCounts } from './NavCounts';
import { useNavModel, type VisibleGroup } from './navModel';
import { OPEN_PALETTE_EVENT } from './quickAdd';

export interface SidebarProps {
  user: CurrentUser;
  /** Phone layout only: whether the sheet is showing. */
  open?: boolean;
  onClose?: () => void;
  /** Desktop: collapsed to an icon rail. */
  rail?: boolean;
  onToggleRail?: () => void;
  onLogout: () => void;
}

const CLOSED_KEY = 'nx-nav-closed';
const ROLE: Record<string, string> = { leader: 'Leader', team_member: 'Team member', intern: 'Intern', guest: 'Guest' };

function loadClosed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function Sidebar({ user, open = false, onClose, rail = false, onToggleRail, onLogout }: SidebarProps) {
  const { groups, active, pathname } = useNavModel(user);
  const counts = useNavCounts();
  const [closed, setClosed] = useState<Set<string>>(loadClosed);
  const navRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<CSSProperties>({ opacity: 0 });
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null);

  const groupOf = (path?: string) => groups.find((g) => g.items.some((i) => i.path === path))?.label;
  const activeGroup = groupOf(active);

  // Going to a page inside a shut group opens it.
  useEffect(() => {
    if (activeGroup && closed.has(activeGroup)) toggleGroup(activeGroup, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroup]);

  function toggleGroup(label: string, forceOpen = false) {
    setClosed((prev) => {
      const next = new Set(prev);
      if (forceOpen || next.has(label)) next.delete(label);
      else next.add(label);
      try {
        localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]));
      } catch {
        /* private window: just not remembered */
      }
      return next;
    });
  }

  // The sliding highlight: measured from the active link, re-measured
  // whenever a group opens or shuts (its height animates) or the rail flips.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const link = active ? nav.querySelector<HTMLElement>(`[data-nav-path="${CSS.escape(active)}"]`) : null;
      const hidden = !link || link.closest('.nx-navg--closed');
      if (hidden) {
        setIndicator((s) => ({ ...s, opacity: 0 }));
        return;
      }
      const n = nav.getBoundingClientRect();
      const r = link.getBoundingClientRect();
      setIndicator({ opacity: 1, transform: `translateY(${r.top - n.top + nav.scrollTop}px)`, height: r.height, width: r.width, left: r.left - n.left });
    };
    measure();
    const ro = new ResizeObserver(measure);
    nav.querySelectorAll('.nx-navg__body').forEach((el) => ro.observe(el));
    ro.observe(nav);
    return () => ro.disconnect();
  }, [active, closed, rail, groups, pathname]);

  function showTip(e: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>, label: string) {
    if (!rail) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ label, top: r.top + r.height / 2, left: r.right + 10 });
  }

  // Phone: swipe the sheet left to shut it.
  const drag = useRef<{ x: number; dx: number } | null>(null);
  const sheetRef = useRef<HTMLElement>(null);
  function onTouchStart(e: React.TouchEvent) {
    if (!open) return;
    drag.current = { x: e.touches[0]!.clientX, dx: 0 };
  }
  function onTouchMove(e: React.TouchEvent) {
    if (!drag.current || !sheetRef.current) return;
    drag.current.dx = Math.min(0, e.touches[0]!.clientX - drag.current.x);
    sheetRef.current.style.transition = 'none';
    sheetRef.current.style.transform = `translateX(${drag.current.dx}px)`;
  }
  function onTouchEnd() {
    if (!drag.current || !sheetRef.current) return;
    const { dx } = drag.current;
    drag.current = null;
    sheetRef.current.style.transition = '';
    sheetRef.current.style.transform = '';
    if (dx < -70) onClose?.();
  }

  return (
    <nav
      ref={sheetRef}
      className={'nx-sidebar' + (open ? ' nx-sidebar--open' : '') + (rail ? ' nx-sidebar--rail' : '')}
      aria-label="Primary"
      id="nx-sidebar"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div className="nx-sidebar__brand">
        <Logo size={19} />
        <button type="button" className="nx-sidebar__railbtn" onClick={onToggleRail} aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'} title={rail ? 'Expand sidebar  [' : 'Collapse sidebar  ['}>
          {rail ? <PanelLeftOpen size={16} strokeWidth={2} aria-hidden="true" /> : <PanelLeftClose size={16} strokeWidth={2} aria-hidden="true" />}
        </button>
        <button type="button" className="nx-sidebar__close" onClick={onClose} aria-label="Close menu">
          <X size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <WorkspaceSwitcher disabled={Boolean(user.impersonatedBy)} compact={rail} />

      <button
        type="button"
        className="nx-sidebar__search"
        onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
        onMouseEnter={(e) => showTip(e, 'Search and jump  ⌘K')}
        onMouseLeave={() => setTip(null)}
        aria-label="Search and jump to a page"
      >
        <Search size={15} strokeWidth={2} aria-hidden="true" />
        <span className="nx-sidebar__searchtext">Search or jump to…</span>
        <kbd className="nx-kbd">⌘K</kbd>
      </button>

      <div className="nx-nav" ref={navRef}>
        <span className="nx-nav__indicator" style={indicator} aria-hidden="true" />
        {groups.map((group) => (
          <Group
            key={group.label}
            group={group}
            isClosed={!rail && closed.has(group.label)}
            onToggle={() => toggleGroup(group.label)}
            active={active}
            pathname={pathname}
            counts={counts}
            rail={rail}
            showTip={showTip}
            hideTip={() => setTip(null)}
          />
        ))}
      </div>

      <UserMenu user={user} rail={rail} onLogout={onLogout} onNavigate={onClose} />

      {rail && tip && (
        <div className="nx-railtip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
          {tip.label}
        </div>
      )}
    </nav>
  );
}

function Group({
  group,
  isClosed,
  onToggle,
  active,
  pathname,
  counts,
  rail,
  showTip,
  hideTip,
}: {
  group: VisibleGroup;
  isClosed: boolean;
  onToggle: () => void;
  active?: string;
  pathname: string;
  counts: ReturnType<typeof useNavCounts>;
  rail: boolean;
  showTip: (e: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>, label: string) => void;
  hideTip: () => void;
}) {
  const id = `nx-navg-${group.label.toLowerCase()}`;
  // What a shut group still tells you: the sum of its red (needs action)
  // counts, so a folded "Ops" still says 59 things are waiting.
  const urgent = group.items.reduce((n, i) => n + (i.count && i.tone === 'danger' && counts ? counts[i.count] ?? 0 : 0), 0);
  const holdsActive = group.items.some((i) => i.path === active);

  return (
    <div className={'nx-navg' + (isClosed ? ' nx-navg--closed' : '')}>
      <button type="button" className="nx-navg__head" onClick={onToggle} aria-expanded={!isClosed} aria-controls={id}>
        <span className="nx-navg__label">{group.label}</span>
        {isClosed && holdsActive && <span className="nx-navg__here" aria-label="The page you're on is in here" />}
        {isClosed && urgent > 0 && <span className="nx-navg__urgent">{urgent}</span>}
        <ChevronDown className="nx-navg__chev" size={14} strokeWidth={2.2} aria-hidden="true" />
      </button>
      <div className="nx-navg__body" id={id}>
        <ul className="nx-navg__inner">
          {group.items.map((item) => {
            const Icon = navIcon(item.icon);
            const isActive = active === item.path;
            const n = item.count && counts ? counts[item.count] : 0;
            const showChildren = !rail && item.children.length > 0 && isActive;
            return (
              <li key={item.path}>
                <NavLink
                  to={item.path}
                  end
                  data-nav-path={item.path}
                  tabIndex={isClosed ? -1 : undefined}
                  className={'nx-nav__link' + (isActive ? ' nx-nav__link--active' : '')}
                  aria-current={isActive ? 'page' : undefined}
                  onMouseEnter={(e) => showTip(e, n ? `${item.label} · ${n}` : item.label)}
                  onMouseLeave={hideTip}
                  onFocus={(e) => showTip(e, item.label)}
                  onBlur={hideTip}
                  aria-label={rail ? item.label : undefined}
                >
                  <Icon className="nx-nav__icon" size={16} strokeWidth={2} aria-hidden="true" />
                  <span className="nx-nav__text">{item.label}</span>
                  {n > 0 && <span className={`nx-nav__count nx-nav__count--${item.tone ?? 'accent'}`}>{n}</span>}
                </NavLink>
                {showChildren && (
                  <ul className="nx-nav__sub">
                    {item.children.map((s) => (
                      <li key={s.path}>
                        <NavLink to={s.path} end className={'nx-nav__sublink' + (pathname === s.path ? ' nx-nav__sublink--active' : '')}>
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
    </div>
  );
}

function UserMenu({ user, rail, onLogout, onNavigate }: { user: CurrentUser; rail: boolean; onLogout: () => void; onNavigate?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div className="nx-me" ref={ref}>
      {open && (
        <div className="nx-me__menu nx-pop nx-pop--up" role="menu">
          <div className="nx-me__who">
            <b>{user.name}</b>
            <span>{user.email}</span>
          </div>
          <div className="nx-me__theme" role="group" aria-label="Theme">
            <button type="button" className={theme === 'light' ? 'is-on' : ''} onClick={() => setTheme('light')} aria-pressed={theme === 'light'}>
              <Sun size={14} strokeWidth={2} aria-hidden="true" /> Light
            </button>
            <button type="button" className={theme === 'dark' ? 'is-on' : ''} onClick={() => setTheme('dark')} aria-pressed={theme === 'dark'}>
              <Moon size={14} strokeWidth={2} aria-hidden="true" /> Dark
            </button>
          </div>
          <NavLink to="/settings" role="menuitem" className="nx-me__item" onClick={() => { setOpen(false); onNavigate?.(); }}>
            <SettingsIcon size={15} strokeWidth={2} aria-hidden="true" /> Settings
          </NavLink>
          <button type="button" role="menuitem" className="nx-me__item" onClick={() => { setOpen(false); window.dispatchEvent(new Event(OPEN_PALETTE_EVENT)); }}>
            <Search size={15} strokeWidth={2} aria-hidden="true" /> Search and jump <kbd className="nx-kbd">⌘K</kbd>
          </button>
          <button type="button" role="menuitem" className="nx-me__item nx-me__item--out" onClick={onLogout}>
            <LogOut size={15} strokeWidth={2} aria-hidden="true" /> Log out
          </button>
        </div>
      )}
      <button type="button" className="nx-me__btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={rail ? `${user.name}: account menu` : undefined}>
        <Avatar name={user.name} size="sm" />
        <span className="nx-me__text">
          <span className="nx-me__name">{user.name}</span>
          <span className="nx-me__role">{ROLE[user.role] ?? user.role}</span>
        </span>
        <ChevronDown className="nx-me__chev" size={14} strokeWidth={2.2} aria-hidden="true" />
      </button>
    </div>
  );
}
