// Session 58 — the top bar of the original HTML app: the page you're on,
// the time, your notifications, and quick actions (Chat, + Goal, and a +
// button that matches the page: + Task, + Partner, + Content …).
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageSquare, Plus } from 'lucide-react';
import { IA } from '../../app/ia';
import { NAV } from '../../app/nav';
import type { CurrentUser } from '../../services/authService';
import { NotificationBell } from './NotificationBell';
import { QUICK_ADD_EVENT } from './quickAdd';
import { Logo } from './Logo';

type Add = { label: string; event?: true; to?: string };

// The + button per page: `event` asks the page on screen to open its own
// create form; `to` goes to the page that creates it.
function addFor(path: string): Add {
  if (path === '/work/team-tasks' || path === '/work/my-tasks' || path === '/work/follow-ups' || path === '/work/completed') return { label: 'Task', event: true };
  if (path === '/network/state') return { label: 'Network', event: true };
  if (path === '/network/partnerships') return { label: 'Partner', event: true };
  if (path === '/network/org-database') return { label: 'Org', event: true };
  if (path.startsWith('/comms-ops/marketing')) return { label: 'Content', to: '/comms-ops/marketing/new' };
  if (path === '/comms-ops/meetings') return { label: 'Meeting', event: true };
  if (path.startsWith('/knowledge')) return { label: 'Entry', to: '/knowledge/edit' };
  return { label: 'Task', to: '/work/my-tasks?new=1' };
}

function titleFor(path: string): string {
  if (path === '/admin') return 'Admin';
  for (const g of NAV) for (const i of g.items) if (i.path === path) return i.label;
  for (const s of IA) {
    const sub = s.subsections.find((x) => x.path === path);
    if (sub) return sub.label === 'Overview' ? s.label : sub.label;
  }
  if (path.startsWith('/work/projects/')) return 'Project';
  if (path.startsWith('/goals/')) return 'Goal';
  if (path.startsWith('/comms-ops/marketing/')) return 'Marketing';
  if (path.startsWith('/knowledge/edit')) return 'Knowledge Base';
  return 'NEXUS';
}

function useClock(): string {
  const fmt = () => new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Africa/Lagos' }).format(new Date()).toUpperCase();
  const [t, setT] = useState(fmt);
  useEffect(() => {
    const id = window.setInterval(() => setT(fmt()), 20_000);
    return () => window.clearInterval(id);
  }, []);
  return t;
}

export function Topbar({ user, onMenu, menuOpen, account }: { user: CurrentUser; onMenu: () => void; menuOpen: boolean; account: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const clock = useClock();
  const isLeader = user.role === 'leader';
  const add = addFor(pathname);

  function quickAdd() {
    if (add.event) window.dispatchEvent(new Event(QUICK_ADD_EVENT));
    else if (add.to) navigate(add.to);
  }

  return (
    <header className="nx-topbar">
      <button type="button" className="nx-topbar__menu" aria-label="Open menu" aria-controls="nx-sidebar" aria-expanded={menuOpen} onClick={onMenu}>
        <svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
        </svg>
      </button>
      <span className="nx-topbar__logo"><Logo size={17} /></span>
      <h1 className="nx-topbar__title">{titleFor(pathname)}</h1>
      <div className="nx-topbar__actions">
        <span className="nx-topbar__clock" aria-label="Time in Abuja">{clock}</span>
        <NotificationBell />
        {isLeader && (
          <button type="button" className="nx-qbtn nx-qbtn--chat" onClick={() => navigate('/ai-analyst/chat')}>
            <MessageSquare size={14} strokeWidth={2.2} aria-hidden="true" /> <span>Chat</span>
          </button>
        )}
        {isLeader && (
          <button type="button" className="nx-qbtn nx-qbtn--goal" onClick={() => navigate('/goals?new=1')}>
            <Plus size={14} strokeWidth={2.4} aria-hidden="true" /> <span>Goal</span>
          </button>
        )}
        <button type="button" className="nx-qbtn nx-qbtn--add" onClick={quickAdd}>
          <Plus size={14} strokeWidth={2.4} aria-hidden="true" /> <span>{add.label}</span>
        </button>
        {account}
      </div>
    </header>
  );
}
