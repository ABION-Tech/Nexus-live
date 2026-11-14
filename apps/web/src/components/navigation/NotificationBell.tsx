// Session 58 — the bell from the original HTML app's top bar: your
// notifications (assignments, escalations, reminders), newest first.
// Reads GET /notifications/inbox; opening one marks it read.
import { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import type { NotificationInboxEntry } from '@nexus/shared';
import { fetchNotificationInbox, markNotificationRead } from '../../services/notificationsService';

function ago(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function NotificationBell() {
  const [items, setItems] = useState<NotificationInboxEntry[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = items.filter((i) => !i.readAt).length;

  const load = () =>
    fetchNotificationInbox({ limit: 20 })
      .then((r) => setItems(r.notifications))
      .catch(() => undefined);

  useEffect(() => {
    void load();
    const t = window.setInterval(load, 90_000);
    return () => window.clearInterval(t);
  }, []);

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

  async function openItem(n: NotificationInboxEntry) {
    if (!n.readAt) {
      setItems((xs) => xs.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      markNotificationRead(n.id).catch(() => undefined);
    }
    if (n.taskId) {
      setOpen(false);
      window.location.assign('/work/my-tasks');
    }
  }

  return (
    <div className="nx-bell" ref={ref}>
      <button type="button" className="nx-iconbtn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Bell size={16} strokeWidth={2} aria-hidden="true" />
        {unread > 0 && <span className="nx-bell__n">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="nx-bell__menu" role="dialog" aria-label="Notifications">
          <div className="nx-bell__head">Notifications</div>
          {items.length === 0 ? (
            <div className="nx-bell__empty">Nothing yet. Assignments, escalations and reminders show up here.</div>
          ) : (
            <ul>
              {items.map((n) => (
                <li key={n.id}>
                  <button type="button" className={'nx-bell__item' + (n.readAt ? '' : ' nx-bell__item--unread')} onClick={() => openItem(n)}>
                    <span className="nx-bell__title">{n.title}</span>
                    {n.body && <span className="nx-bell__body">{n.body}</span>}
                    <span className="nx-bell__when">{ago(n.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
