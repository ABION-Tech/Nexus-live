// Session 62 — the morning email, rewritten. It used to say "12 open
// tasks · 3 overdue" and nothing else. Now it is the person's day:
// the headline in a sentence, free time against the work due, the
// calendar, what's late and by how long, what's due and by when (with
// the next checklist step), what's on the go, the rest of the week, and
// — for leaders — who on the team is stuck. Every task links straight to
// it in NEXUS, in the right company.
//
// Rendering is pure (renderMyDayEmail) so it can be tested and previewed;
// sendMyDayEmail just hands it to the email provider.
import { getEmailProvider } from '../integrations/emailProvider.js';
import { dueText, fmtClock, fmtMinutes, type DayEvent, type DayTask, type MyDay } from './myDayService.js';

const C = {
  ink: '#16151f',
  dim: '#6b6a78',
  faint: '#9a99a6',
  line: '#e7e6ee',
  bg: '#f5f5f9',
  card: '#ffffff',
  accent: '#5b52f0',
  accentSoft: '#eeedfe',
  red: '#d6334a',
  redSoft: '#fdecef',
  amber: '#b7791f',
  amberSoft: '#fdf4e3',
  green: '#0f9d76',
  greenSoft: '#e5f7f1',
};
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const PRIORITY: Record<string, { label: string; color: string; bg: string }> = {
  urgent: { label: 'Urgent', color: C.red, bg: C.redSoft },
  high: { label: 'High', color: C.amber, bg: C.amberSoft },
  medium: { label: 'Medium', color: C.dim, bg: C.bg },
  low: { label: 'Low', color: C.faint, bg: C.bg },
};

export function taskLink(base: string, t: { id: string; companyId: string }, page = '/work/my-tasks'): string {
  return `${base}${page}?task=${encodeURIComponent(t.id)}&org=${encodeURIComponent(t.companyId)}`;
}

function eventTime(e: DayEvent): string {
  if (e.allDay) return 'All day';
  return e.end ? `${fmtClock(e.start)} – ${fmtClock(e.end)}` : fmtClock(e.start);
}

function taskMeta(t: DayTask, now: Date, multiCompany: boolean): string[] {
  const m: string[] = [];
  if (multiCompany) m.push(t.company);
  const due = dueText(t, now);
  if (due) m.push(due);
  if (t.status === 'blocked') m.push('Blocked');
  else if (t.status === 'in_progress') m.push('In progress');
  if (t.estimateMinutes) m.push(`needs ~${fmtMinutes(t.estimateMinutes)}`);
  if (t.checklistTotal) m.push(`${t.checklistDone}/${t.checklistTotal} steps done`);
  if (t.role !== 'owner') m.push(t.role === 'support' ? 'you support' : 'you supervise');
  return m;
}

// ---- HTML pieces -----------------------------------------------------

function sectionHead(title: string, note?: string, color = C.ink): string {
  return `<tr><td style="padding:28px 0 10px;font-family:${FONT}">
    <div style="font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${color}">${esc(title)}</div>
    ${note ? `<div style="font-size:13px;color:${C.dim};margin-top:3px">${esc(note)}</div>` : ''}
  </td></tr>`;
}

function taskRow(t: DayTask, base: string, now: Date, multi: boolean, bar: string, page?: string): string {
  const p = PRIORITY[t.priority] ?? PRIORITY.medium!;
  const showPriority = t.priority === 'urgent' || t.priority === 'high';
  return `<tr><td style="padding:0 0 8px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-left:4px solid ${bar};border-radius:10px">
      <tr><td style="padding:12px 14px;font-family:${FONT}">
        <a href="${esc(taskLink(base, t, page))}" style="font-size:15px;font-weight:600;color:${C.ink};text-decoration:none;line-height:1.35">${esc(t.title)}</a>
        ${showPriority ? ` <span style="display:inline-block;font-size:11px;font-weight:700;color:${p.color};background:${p.bg};border-radius:5px;padding:1px 6px;margin-left:4px;vertical-align:2px">${p.label}</span>` : ''}
        <div style="font-size:13px;color:${C.dim};margin-top:4px;line-height:1.45">${taskMeta(t, now, multi).map(esc).join(' &middot; ')}</div>
        ${t.nextStep ? `<div style="font-size:13px;color:${C.ink};margin-top:6px;line-height:1.45"><span style="color:${C.accent};font-weight:700">Next step:</span> ${esc(t.nextStep)}</div>` : ''}
      </td></tr>
    </table>
  </td></tr>`;
}

function moreRow(n: number, base: string): string {
  return n > 0
    ? `<tr><td style="padding:0 0 8px;font-family:${FONT};font-size:13px"><a href="${esc(base)}/work/my-tasks" style="color:${C.accent};text-decoration:none">+ ${n} more in My Tasks</a></td></tr>`
    : '';
}

function timeStrip(day: MyDay): string {
  const t = day.time;
  if (t.minutesLeft <= 0) return '';
  const short = t.neededMinutes > t.freeMinutes;
  const cells = [
    { k: 'Free time today', v: fmtMinutes(t.freeMinutes), sub: `of ${fmtMinutes(t.minutesLeft)}, ${t.workdayStart}–${t.workdayEnd}`, c: C.green, bg: C.greenSoft },
    { k: 'In meetings', v: fmtMinutes(t.busyMinutes), sub: t.busyMinutes ? 'already booked' : 'nothing booked', c: C.accent, bg: C.accentSoft },
    {
      k: "Today's work needs",
      v: t.neededMinutes ? `~${fmtMinutes(t.neededMinutes)}` : '—',
      sub: t.unestimated ? `${t.unestimated} task${t.unestimated === 1 ? '' : 's'} not estimated` : short ? `${fmtMinutes(t.neededMinutes - t.freeMinutes)} over` : t.neededMinutes ? 'fits in your day' : 'add time to tasks',
      c: short ? C.red : C.ink,
      bg: short ? C.redSoft : C.bg,
    },
  ];
  return `<tr><td style="padding:18px 0 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${cells
        .map(
          (x, i) => `<td width="33%" valign="top" style="padding:${i ? '0 0 0 6px' : '0'}">
        <div style="background:${x.bg};border-radius:10px;padding:12px;font-family:${FONT}">
          <div style="font-size:12px;color:${C.dim}">${esc(x.k)}</div>
          <div style="font-size:20px;font-weight:700;color:${x.c};margin-top:2px">${esc(x.v)}</div>
          <div style="font-size:12px;color:${C.dim};margin-top:2px">${esc(x.sub)}</div>
        </div></td>`
        )
        .join('')}
    </tr></table>
  </td></tr>`;
}

function scheduleBlock(day: MyDay): string {
  if (!day.events.length) return '';
  const now = Date.parse(day.generatedAt);
  return (
    sectionHead('Your calendar today') +
    `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-radius:10px">
      ${day.events
        .map((e, i) => {
          const past = e.end && !e.allDay && Date.parse(e.end) < now;
          const where = [e.company, e.location].filter(Boolean).join(' · ');
          return `<tr><td style="padding:11px 14px;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${FONT};${past ? 'opacity:.5;' : ''}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td width="118" valign="top" style="font-size:13px;font-weight:700;color:${C.accent};font-family:${FONT};white-space:nowrap">${esc(eventTime(e))}</td>
              <td valign="top" style="font-family:${FONT}"><div style="font-size:14px;color:${C.ink};font-weight:600">${esc(e.title)}</div>${where ? `<div style="font-size:12px;color:${C.dim};margin-top:2px">${esc(where)}</div>` : ''}</td>
            </tr></table>
          </td></tr>`;
        })
        .join('')}
    </table></td></tr>`
  );
}

function teamBlock(day: MyDay, base: string): string {
  if (!day.team.length) return '';
  const multi = day.team.length > 1;
  let out = sectionHead('Your team', 'What people are waiting on you for, or need a nudge about.');
  for (const t of day.team) {
    const lines: string[] = [];
    for (const b of t.blocked)
      lines.push(`<span style="color:${C.red};font-weight:700">Blocked</span> &nbsp;<a href="${esc(taskLink(base, { id: b.id, companyId: t.companyId }, '/work/team-tasks'))}" style="color:${C.ink};text-decoration:none">${esc(b.title)}</a> <span style="color:${C.dim}">— ${esc(b.owner ?? 'unassigned')}</span>`);
    for (const l of t.lateByOthers)
      lines.push(`<span style="color:${C.amber};font-weight:700">${l.lateDays}d late</span> &nbsp;<a href="${esc(taskLink(base, { id: l.id, companyId: t.companyId }, '/work/team-tasks'))}" style="color:${C.ink};text-decoration:none">${esc(l.title)}</a> <span style="color:${C.dim}">— ${esc(l.owner ?? 'unassigned')}</span>`);
    if (t.missingEod.length) {
      const d = new Date(t.missingEodDate + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
      lines.push(`<span style="color:${C.dim};font-weight:700">No EOD ${esc(d)}</span> &nbsp;${esc(t.missingEod.length > 8 ? `${t.missingEod.slice(0, 8).join(', ')} and ${t.missingEod.length - 8} more` : t.missingEod.join(', '))}`);
    }
    out += `<tr><td style="padding:0 0 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-radius:10px"><tr><td style="padding:12px 14px;font-family:${FONT};font-size:13px;line-height:1.9">
      ${multi ? `<div style="font-size:12px;font-weight:700;color:${C.dim};text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">${esc(t.company)}</div>` : ''}
      ${lines.join('<br>')}
    </td></tr></table></td></tr>`;
  }
  return out;
}

// ---- the email -------------------------------------------------------

export function myDaySubject(day: MyDay, monday = false): string {
  const when = new Date(day.date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const lead = monday ? 'Your week' : 'Your day';
  const top = day.dueToday[0] ?? day.overdue[0];
  if (!top) return `${lead}, ${when}: nothing due today`;
  const rest = day.overdue.length + day.more.overdue + day.dueToday.length + day.more.dueToday - 1;
  return `${lead}, ${when}: ${top.title.length > 48 ? top.title.slice(0, 46) + '…' : top.title}${rest > 0 ? ` + ${rest} more` : ''}`;
}

export function renderMyDayEmail(day: MyDay, base: string, opts: { monday?: boolean } = {}): { subject: string; text: string; html: string } {
  const now = new Date(day.generatedAt);
  const multi = day.companies.length > 1;
  const subject = myDaySubject(day, opts.monday);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: 'numeric', hourCycle: 'h23' }).format(now));
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  let body = '';
  body += timeStrip(day);
  body += scheduleBlock(day);
  if (day.dueToday.length) {
    body += sectionHead('Due today', 'In the order they fall due.', C.accent);
    body += day.dueToday.map((t) => taskRow(t, base, now, multi, C.accent)).join('') + moreRow(day.more.dueToday, base);
  }
  if (day.overdue.length) {
    body += sectionHead('Overdue', 'Finish it, or move the deadline so people know where it stands.', C.red);
    body += day.overdue.map((t) => taskRow(t, base, now, multi, C.red)).join('') + moreRow(day.more.overdue, base);
  }
  if (day.onTheGo.length) {
    body += sectionHead('On the go', 'Started or in progress, no deadline this week.');
    body += day.onTheGo.map((t) => taskRow(t, base, now, multi, C.line)).join('') + moreRow(day.more.onTheGo, base);
  }
  if (day.upcoming.length) {
    body += sectionHead(opts.monday ? 'This week' : 'Coming up', 'The next seven days.');
    for (const u of day.upcoming) {
      body += `<tr><td style="padding:6px 0 6px;font-family:${FONT};font-size:13px;font-weight:700;color:${C.dim}">${esc(u.label)}</td></tr>`;
      body += u.tasks.map((t) => taskRow(t, base, now, multi, C.line)).join('');
    }
  }
  body += teamBlock(day, base);

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(day.headline)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
  <tr><td style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.accent}">NEXUS &middot; ${esc(day.dateLabel)}</td></tr>
  <tr><td style="font-family:${FONT};font-size:26px;font-weight:700;color:${C.ink};padding-top:8px">${greet}, ${esc(day.firstName)}.</td></tr>
  <tr><td style="font-family:${FONT};font-size:16px;line-height:1.5;color:${C.ink};padding-top:8px">${esc(day.headline)}</td></tr>
  ${body}
  <tr><td style="padding:28px 0 0"><a href="${esc(base)}/dashboard" style="display:inline-block;background:${C.accent};color:#ffffff;font-family:${FONT};font-size:15px;font-weight:600;text-decoration:none;border-radius:9px;padding:12px 22px">Open my day in NEXUS</a></td></tr>
  <tr><td style="padding:22px 0 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.faint}">
    Covers ${esc(day.companies.map((c) => c.name).join(', '))}. Free time counts ${day.time.workdayStart}–${day.time.workdayEnd} Lagos time, less meetings. Add “Time needed” to a task and it’s counted in what today’s work needs.
  </td></tr>
</table></td></tr></table></body></html>`;

  // Plain-text version, same content.
  const lines: string[] = [`${greet}, ${day.firstName}. ${day.dateLabel}.`, '', day.headline, ''];
  const t = day.time;
  if (t.minutesLeft > 0) lines.push(`Free today: ${fmtMinutes(t.freeMinutes)} · In meetings: ${fmtMinutes(t.busyMinutes)} · Work due needs: ${t.neededMinutes ? '~' + fmtMinutes(t.neededMinutes) : 'not estimated'}`, '');
  const list = (title: string, tasks: DayTask[]) => {
    if (!tasks.length) return;
    lines.push(title.toUpperCase());
    for (const x of tasks) {
      lines.push(`- ${x.title} (${taskMeta(x, now, multi).join(', ')})`);
      if (x.nextStep) lines.push(`  Next step: ${x.nextStep}`);
    }
    lines.push('');
  };
  if (day.events.length) {
    lines.push('YOUR CALENDAR TODAY');
    for (const e of day.events) lines.push(`- ${eventTime(e)}  ${e.title}${e.company ? ` (${e.company})` : ''}`);
    lines.push('');
  }
  list('Due today', day.dueToday);
  list('Overdue', day.overdue);
  list('On the go', day.onTheGo);
  for (const u of day.upcoming) list(u.label, u.tasks);
  for (const tm of day.team) {
    lines.push(`YOUR TEAM${day.team.length > 1 ? ` · ${tm.company}` : ''}`);
    for (const b of tm.blocked) lines.push(`- Blocked: ${b.title} (${b.owner ?? 'unassigned'})`);
    for (const l of tm.lateByOthers) lines.push(`- ${l.lateDays}d late: ${l.title} (${l.owner ?? 'unassigned'})`);
    if (tm.missingEod.length) lines.push(`- No EOD: ${tm.missingEod.join(', ')}`);
    lines.push('');
  }
  lines.push(`Open my day: ${base}/dashboard`);

  return { subject, text: lines.join('\n'), html };
}

export async function sendMyDayEmail(to: string, day: MyDay, base: string, opts: { monday?: boolean } = {}): Promise<void> {
  const { subject, text, html } = renderMyDayEmail(day, base, opts);
  await getEmailProvider().send({ to, subject, text, html });
}
