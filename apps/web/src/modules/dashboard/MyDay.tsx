// Session 62 — "My day" at the top of the dashboard: the same day the
// morning email describes, live. What's late and by how long, what's due
// and by when, the calendar on a 09:00–18:00 bar with a "now" line, the
// free time left against what the work needs, what's coming up, and —
// for leaders — who on the team is stuck. Every task opens in its own
// company. Close it (×) and it stays hidden until tomorrow; "My day"
// brings it back.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, ChevronDown, Sun, X } from 'lucide-react';
import { useWorkspaces } from '../../components/navigation/WorkspaceContext';
import { dueText, fetchMyDay, fmtClock, fmtMinutes, lagosMinutes, type DayTask, type MyDay as Day } from '../../services/myDayService';

const HIDE_KEY = 'nx-myday-hidden';
const START = 9 * 60;
const END = 18 * 60;

function readHidden(): string | null {
  try {
    return localStorage.getItem(HIDE_KEY);
  } catch {
    return null;
  }
}
function writeHidden(v: string | null) {
  try {
    if (v) localStorage.setItem(HIDE_KEY, v);
    else localStorage.removeItem(HIDE_KEY);
  } catch {
    /* private mode: hiding just won't stick */
  }
}

const pct = (m: number) => `${Math.min(100, Math.max(0, ((m - START) / (END - START)) * 100))}%`;

export function MyDay() {
  const navigate = useNavigate();
  const { current, switchTo } = useWorkspaces();
  const [day, setDay] = useState<Day | null>(null);
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState<string | null>(readHidden);
  const [now, setNow] = useState(() => new Date());
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchMyDay()
      .then(setDay)
      .catch(() => setFailed(true));
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const nowMin = lagosMinutes(now);
  const isHidden = !!day && hidden === day.date;

  // Free time, recomputed live as the day goes on.
  const live = useMemo(() => {
    if (!day) return null;
    const from = Math.max(START, nowMin);
    const left = Math.max(0, END - from);
    let busy = 0;
    for (const e of day.events) {
      if (e.allDay || !e.end) continue;
      const a = Math.max(from, lagosMinutes(new Date(e.start)));
      const b = Math.min(END, lagosMinutes(new Date(e.end)));
      if (b > a) busy += b - a;
    }
    return { left, busy: Math.min(busy, left), free: Math.max(0, left - busy) };
  }, [day, nowMin]);

  if (failed || !day || !live) return null;

  if (isHidden) {
    return (
      <button type="button" className="nx-myday-reopen nx-chipbtn" onClick={() => { writeHidden(null); setHidden(null); }}>
        <Sun size={14} aria-hidden="true" /> My day
      </button>
    );
  }

  const multi = day.companies.length > 1;
  const open = (t: { id: string; companyId: string }, page = '/work/my-tasks') => {
    const path = `${page}?task=${encodeURIComponent(t.id)}`;
    if (!current || current.orgId === t.companyId) navigate(path);
    else void switchTo(t.companyId, path);
  };

  const list = (key: string, tasks: DayTask[], tone: 'red' | 'accent' | 'plain', extra = 0) => {
    const all = showAll[key];
    const shown = all ? tasks : tasks.slice(0, 5);
    const hiddenCount = tasks.length - shown.length;
    return (
      <ul className="nx-myday__tasks">
        {shown.map((t) => {
          const meta = [multi ? t.company : null, dueText(t, day.date, now), t.status === 'blocked' ? 'Blocked' : t.status === 'in_progress' ? 'In progress' : null,
            t.estimateMinutes ? `needs ~${fmtMinutes(t.estimateMinutes)}` : null, t.checklistTotal ? `${t.checklistDone}/${t.checklistTotal} steps` : null,
            t.role === 'support' ? 'you support' : t.role === 'supervisor' ? 'you supervise' : null].filter(Boolean);
          return (
            <li key={t.id}>
              <button type="button" className={`nx-myday__task nx-myday__task--${tone}`} onClick={() => open(t)}>
                <span className="nx-myday__title">
                  {t.title}
                  {(t.priority === 'urgent' || t.priority === 'high') && <span className={`nx-myday__pri nx-myday__pri--${t.priority}`}>{t.priority === 'urgent' ? 'Urgent' : 'High'}</span>}
                </span>
                <span className="nx-myday__meta">{meta.join(' · ')}</span>
                {t.nextStep && <span className="nx-myday__next"><b>Next:</b> {t.nextStep}</span>}
              </button>
            </li>
          );
        })}
        {(hiddenCount > 0 || extra > 0) && (
          <li>
            <button type="button" className="nx-myday__more" onClick={() => (hiddenCount > 0 ? setShowAll((s) => ({ ...s, [key]: true })) : navigate('/work/my-tasks'))}>
              {hiddenCount > 0 ? `Show ${hiddenCount + extra} more` : `${extra} more in My Tasks`} <ChevronDown size={14} aria-hidden="true" />
            </button>
          </li>
        )}
      </ul>
    );
  };

  const t = day.time;
  const short = t.neededMinutes > live.free;
  const timed = day.events.filter((e) => !e.allDay && e.end);
  const allDay = day.events.filter((e) => e.allDay);
  const nothing = !day.overdue.length && !day.dueToday.length && !day.onTheGo.length && !day.upcoming.length;

  return (
    <section className="nx-myday nx-pop" aria-label="My day">
      <header className="nx-myday__head">
        <div>
          <div className="nx-myday__eyebrow"><Sun size={13} aria-hidden="true" /> My day · {day.dateLabel}</div>
          <p className="nx-myday__headline">{day.headline}</p>
        </div>
        <button type="button" className="nx-iconbtn nx-myday__close" aria-label="Hide My day until tomorrow" title="Hide until tomorrow" onClick={() => { writeHidden(day.date); setHidden(day.date); }}>
          <X size={16} />
        </button>
      </header>

      <div className="nx-myday__time">
        <div className="nx-myday__stats">
          <div className="nx-myday__stat nx-myday__stat--free"><span>Free time left</span><b>{fmtMinutes(live.free)}</b><small>of {fmtMinutes(live.left)} until 6 pm</small></div>
          <div className="nx-myday__stat"><span>In meetings</span><b>{fmtMinutes(live.busy)}</b><small>{timed.length ? `${timed.length} on the calendar` : 'nothing booked'}</small></div>
          <div className={'nx-myday__stat' + (short ? ' nx-myday__stat--short' : '')}>
            <span>Today's work needs</span>
            <b>{t.neededMinutes ? `~${fmtMinutes(t.neededMinutes)}` : '—'}</b>
            <small>{t.unestimated ? `${t.unestimated} task${t.unestimated === 1 ? '' : 's'} have no time set` : short ? `${fmtMinutes(t.neededMinutes - live.free)} more than you have` : t.neededMinutes ? 'fits in your day' : 'set "Time needed" on tasks'}</small>
          </div>
        </div>
        <div className="nx-myday__bar" aria-hidden="true">
          <div className="nx-myday__past" style={{ width: pct(nowMin) }} />
          {timed.map((e, i) => (
            <div key={i} className="nx-myday__block" style={{ left: pct(lagosMinutes(new Date(e.start))), width: `calc(${pct(lagosMinutes(new Date(e.end!)))} - ${pct(lagosMinutes(new Date(e.start)))})` }} title={`${fmtClock(e.start)} – ${fmtClock(e.end!)} ${e.title}`} />
          ))}
          {day.dueToday.filter((x) => x.deadlineHasTime && x.deadline).map((x) => (
            <div key={x.id} className="nx-myday__due" style={{ left: pct(lagosMinutes(new Date(x.deadline!))) }} title={`${x.title} due ${fmtClock(x.deadline!)}`} />
          ))}
          {nowMin >= START && nowMin <= END && <div className="nx-myday__now" style={{ left: pct(nowMin) }} />}
          <span className="nx-myday__tick" style={{ left: 0 }}>9</span>
          <span className="nx-myday__tick" style={{ left: '33.33%' }}>12</span>
          <span className="nx-myday__tick" style={{ left: '66.66%' }}>3</span>
          <span className="nx-myday__tick" style={{ left: '100%' }}>6</span>
        </div>
      </div>

      <div className="nx-myday__cols">
        <div className="nx-myday__col">
          {day.dueToday.length > 0 && (
            <div className="nx-myday__group">
              <h3 className="nx-myday__h nx-myday__h--accent">Due today <em>{day.dueToday.length + day.more.dueToday}</em></h3>
              {list('today', day.dueToday, 'accent', day.more.dueToday)}
            </div>
          )}
          {day.overdue.length > 0 && (
            <div className="nx-myday__group">
              <h3 className="nx-myday__h nx-myday__h--red">Overdue <em>{day.overdue.length + day.more.overdue}</em></h3>
              {list('overdue', day.overdue, 'red', day.more.overdue)}
            </div>
          )}
          {day.onTheGo.length > 0 && (
            <div className="nx-myday__group">
              <h3 className="nx-myday__h">On the go</h3>
              {list('go', day.onTheGo, 'plain', day.more.onTheGo)}
            </div>
          )}
          {nothing && <p className="nx-myday__empty">Nothing on your plate. New tasks assigned to you will show here.</p>}
        </div>

        <div className="nx-myday__col">
          <div className="nx-myday__group">
            <h3 className="nx-myday__h"><CalendarDays size={13} aria-hidden="true" /> Calendar today</h3>
            {day.events.length === 0 ? (
              <p className="nx-myday__empty">No meetings today. Connect Google Calendar in Settings to see your own events here.</p>
            ) : (
              <ul className="nx-myday__events">
                {[...allDay, ...timed].map((e, i) => {
                  const past = !e.allDay && e.end && Date.parse(e.end) < now.getTime();
                  const isNow = !e.allDay && e.end && Date.parse(e.start) <= now.getTime() && Date.parse(e.end) > now.getTime();
                  return (
                    <li key={i} className={(past ? 'is-past' : '') + (isNow ? ' is-live' : '')}>
                      <span className="nx-myday__when">{e.allDay ? 'All day' : `${fmtClock(e.start)} – ${fmtClock(e.end!)}`}</span>
                      <span className="nx-myday__what">{e.title}{isNow && <i>now</i>}</span>
                      {(e.company || e.location) && <span className="nx-myday__where">{[e.company, e.location].filter(Boolean).join(' · ')}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {day.upcoming.length > 0 && (
            <div className="nx-myday__group">
              <h3 className="nx-myday__h">Coming up</h3>
              <ul className="nx-myday__week">
                {day.upcoming.map((u) => (
                  <li key={u.date}>
                    <span className="nx-myday__day">{u.label}</span>
                    {u.tasks.map((x) => (
                      <button key={x.id} type="button" onClick={() => open(x)}>
                        {x.title}
                        {multi && <small> · {x.company}</small>}
                      </button>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {day.team.length > 0 && (
            <div className="nx-myday__group">
              <h3 className="nx-myday__h">Your team</h3>
              {day.team.map((tm) => (
                <ul key={tm.companyId} className="nx-myday__team">
                  {day.team.length > 1 && <li className="nx-myday__co">{tm.company}</li>}
                  {tm.blocked.map((b) => (
                    <li key={b.id}><button type="button" onClick={() => open({ id: b.id, companyId: tm.companyId }, '/work/team-tasks')}><em className="is-red">Blocked</em> {b.title} <small>— {b.owner ?? 'unassigned'}</small></button></li>
                  ))}
                  {tm.lateByOthers.map((l) => (
                    <li key={l.id}><button type="button" onClick={() => open({ id: l.id, companyId: tm.companyId }, '/work/team-tasks')}><em className="is-amber">{l.lateDays}d late</em> {l.title} <small>— {l.owner ?? 'unassigned'}</small></button></li>
                  ))}
                  {tm.missingEod.length > 0 && (
                    <li className="nx-myday__eod"><em>No EOD</em> {tm.missingEod.length > 6 ? `${tm.missingEod.slice(0, 6).join(', ')} and ${tm.missingEod.length - 6} more` : tm.missingEod.join(', ')}</li>
                  )}
                </ul>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
