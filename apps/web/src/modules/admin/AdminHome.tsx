// Session 58 — one landing layout for Company, Group and Super Admin, so
// each opens on something to do rather than a row of bare numbers:
//   header      what this admin area is for + its main action
//   numbers     live counts, each one a link to where you'd act on it
//   actions     the jobs done here, one click each
//   activity    the latest entries from this area's audit log
//   extra       an area-specific panel (companies list, system health …)
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import type { AuditLogEntry } from '@nexus/shared';

export interface AdminStat {
  label: string;
  value: number | string;
  to?: string;
  tone?: 'accent' | 'green' | 'red' | 'amber';
}

export interface AdminAction {
  icon: LucideIcon;
  title: string;
  text: string;
  to: string;
}

const VERB: Record<string, string> = {
  create: 'created', update: 'updated', delete: 'deleted', archive: 'archived', invite: 'invited', accept: 'accepted',
  revoke: 'revoked', login: 'signed in', logout: 'signed out', grant: 'granted', remove: 'removed', approve: 'approved',
  reject: 'rejected', deactivate: 'deactivated', assign: 'assigned', role_change: 'role changed', start: 'started', end: 'ended',
};

/** "invite.accept" → "Invite accepted"; "org.role_change" → "Org role changed". */
export function describeAction(action: string): string {
  const [thing = action, verb = ''] = action.split('.');
  const t = thing.replace(/_/g, ' ');
  const v = VERB[verb] ?? verb.replace(/_/g, ' ');
  const s = `${t} ${v}`.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ago(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function AdminHome({
  kicker,
  title,
  lede,
  primary,
  stats,
  actions,
  activity,
  activityTo,
  nameOf,
  extra,
}: {
  kicker: string;
  title: string;
  lede: string;
  primary?: { label: string; to: string };
  stats: AdminStat[];
  actions: AdminAction[];
  activity: AuditLogEntry[] | null;
  activityTo: string;
  nameOf?: (userId?: string) => string | undefined;
  extra?: ReactNode;
}) {
  return (
    <div className="nx-dashboard-overview nx-view-enter nx-adminhome">
      <header className="nx-adminhome__head">
        <div>
          <div className="nx-adminhome__kicker">{kicker}</div>
          <h1 className="nx-adminhome__title">{title}</h1>
          <p className="nx-adminhome__lede">{lede}</p>
        </div>
        {primary && (
          <Link className="nx-qbtn nx-qbtn--add nx-adminhome__primary" to={primary.to}>
            {primary.label}
          </Link>
        )}
      </header>

      <div className="nx-adminhome__stats">
        {stats.map((s) => {
          const body = (
            <>
              <span className="nx-adminhome__n">{s.value}</span>
              <span className="nx-adminhome__l">{s.label}</span>
            </>
          );
          const cls = `nx-adminhome__stat nx-adminhome__stat--${s.tone ?? 'accent'}`;
          return s.to ? (
            <Link key={s.label} className={cls} to={s.to}>
              {body}
            </Link>
          ) : (
            <div key={s.label} className={cls}>
              {body}
            </div>
          );
        })}
      </div>

      <div className="nx-adminhome__grid">
        <section className="nx-card nx-adminhome__actions" aria-label="What you can do here">
          <h2 className="nx-adminhome__h2">What you can do here</h2>
          <div className="nx-adminhome__tiles">
            {actions.map((a) => (
              <Link key={a.to + a.title} to={a.to} className="nx-adminhome__tile">
                <span className="nx-adminhome__ticon"><a.icon size={17} strokeWidth={2} aria-hidden="true" /></span>
                <span className="nx-adminhome__ttext">
                  <b>{a.title}</b>
                  <span>{a.text}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section className="nx-card nx-adminhome__feed" aria-label="Recent activity">
          <div className="nx-adminhome__feedhead">
            <h2 className="nx-adminhome__h2">Recent activity</h2>
            <Link className="nx-chipbtn" to={activityTo}>See all</Link>
          </div>
          {activity === null ? (
            <p className="nx-cell-dim">Loading…</p>
          ) : activity.length === 0 ? (
            <p className="nx-cell-dim">Nothing recorded yet. Sign-ins, invites, role changes and edits show up here as they happen.</p>
          ) : (
            <ul className="nx-adminhome__events">
              {activity.slice(0, 8).map((e) => (
                <li key={e.id} className={e.result === 'success' ? undefined : 'nx-adminhome__event--bad'}>
                  <span className="nx-adminhome__dot" aria-hidden="true" />
                  <span className="nx-adminhome__etext">
                    <b>{describeAction(e.action)}</b>
                    <span>
                      {nameOf?.(e.userId) ?? 'Someone'} · {ago(e.timestamp)}
                      {e.result !== 'success' && ` · ${e.result}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {extra}
    </div>
  );
}
