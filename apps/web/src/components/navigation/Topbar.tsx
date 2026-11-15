// Session 58 — the top bar of the original HTML app: the page you're on,
// the time, your notifications, and quick actions (Chat, + Goal, and a +
// button that matches the page: + Task, + Partner, + Content …).
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageSquare, Plus, Search } from 'lucide-react';
import { IA } from '../../app/ia';
import { NAV } from '../../app/nav';
import type { CurrentUser } from '../../services/authService';
import { NotificationBell } from './NotificationBell';
import { QUICK_ADD_EVENT } from './quickAdd';
import { Logo } from './Logo';
import { OPEN_PALETTE_EVENT } from './quickAdd';

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

// Session 61: the account controls moved to the sidebar's foot menu, and
// phones use the bottom tab bar instead of a hamburger.
export function Topbar({ user }: { user: CurrentUser }) {
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
      <span className="nx-topbar__logo"><Logo size={17} /></span>
      <h1 className="nx-topbar__title">{titleFor(pathname)}</h1>
      <div className="nx-topbar__actions">
        <span className="nx-topbar__clock" aria-label="Time in Abuja">{clock}</span>
        <button type="button" className="nx-iconbtn nx-topbar__search" aria-label="Search and jump (⌘K)" title="Search and jump  ⌘K" onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}>
          <Search size={16} strokeWidth={2} aria-hidden="true" />
        </button>
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
      </div>
    </header>
  );
}
