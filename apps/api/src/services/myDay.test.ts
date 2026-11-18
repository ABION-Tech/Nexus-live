// Session 62 — My day: grouping, time arithmetic, wording, and the email.
import { describe, expect, it } from 'vitest';
import { assembleMyDay, busyMinutesBetween, deadlineDate, deadlineHasTime, dueText, previousWorkday, type DayInputs, type DayTask } from './myDayService.js';
import { myDaySubject, renderMyDayEmail, taskLink } from './myDayEmail.js';

// 08:05 Lagos on Wednesday 18 November 2026.
const NOW = new Date('2026-11-18T07:05:00Z');

function task(p: Partial<DayTask>): DayTask {
  return {
    id: p.id ?? Math.random().toString(36).slice(2),
    title: 'Task',
    companyId: 'c1',
    company: 'ABION',
    priority: 'medium',
    status: 'not_started',
    role: 'owner',
    deadline: null,
    deadlineHasTime: false,
    startDate: null,
    estimateMinutes: null,
    nextStep: null,
    checklistDone: 0,
    checklistTotal: 0,
    ...p,
  };
}
const inputs = (tasks: DayTask[], extra: Partial<DayInputs> = {}): DayInputs => ({
  name: 'Ayomide Abion',
  companies: [{ id: 'c1', name: 'ABION', role: 'leader' }],
  tasks,
  events: [],
  team: [],
  ...extra,
});

describe('deadlines', () => {
  it('treats date-picker deadlines as dates, real times as times', () => {
    expect(deadlineHasTime('2026-11-18T00:00:00.000Z')).toBe(false); // UTC midnight
    expect(deadlineHasTime('2026-11-17T23:00:00.000Z')).toBe(false); // Lagos midnight
    expect(deadlineHasTime('2026-11-18T15:00:00.000Z')).toBe(true); // 4 pm Lagos
  });
  it('a date-only deadline is the date that was picked', () => {
    expect(deadlineDate('2026-11-17T23:00:00.000Z')).toBe('2026-11-18'); // Lagos midnight (imports)
    expect(deadlineDate('2026-11-18T00:00:00.000Z')).toBe('2026-11-18'); // UTC midnight (the form)
  });
  it('says when, in words', () => {
    expect(dueText(task({ deadline: '2026-11-18T15:00:00.000Z', deadlineHasTime: true }), NOW)).toBe('by 4 pm, in 7h 55m');
    expect(dueText(task({ deadline: '2026-11-18T00:00:00.000Z' }), NOW)).toBe('by end of day');
    expect(dueText(task({ deadline: '2026-11-19T00:00:00.000Z' }), NOW)).toBe('due tomorrow');
    expect(dueText(task({ deadline: '2026-11-10T00:00:00.000Z', lateDays: 8 }), NOW)).toBe('8 days late');
  });
  it('previous working day skips the weekend', () => {
    expect(previousWorkday('2026-11-16')).toBe('2026-11-13'); // Mon → Fri
    expect(previousWorkday('2026-11-18')).toBe('2026-11-17');
  });
});

describe('assembleMyDay', () => {
  const day = assembleMyDay(
    inputs([
      task({ id: 'late', title: 'Late one', deadline: '2026-11-15T00:00:00.000Z', estimateMinutes: 60 }),
      task({ id: 'eod', title: 'End of day', deadline: '2026-11-18T00:00:00.000Z', estimateMinutes: 120 }),
      task({ id: 'four', title: 'By four', deadline: '2026-11-18T15:00:00.000Z', deadlineHasTime: true }),
      task({ id: 'fri', title: 'Friday', deadline: '2026-11-20T00:00:00.000Z' }),
      task({ id: 'go', title: 'Going', status: 'in_progress' }),
      task({ id: 'idle', title: 'Someday' }),
      task({ id: 'sup', title: 'I support', deadline: '2026-11-18T00:00:00.000Z', role: 'support', estimateMinutes: 600 }),
    ], {
      events: [
        { start: '2026-11-18T09:00:00.000Z', end: '2026-11-18T10:00:00.000Z', allDay: false, title: 'Standup', company: 'ABION', kind: 'meeting', location: null },
        { start: '2026-11-18T09:30:00.000Z', end: '2026-11-18T10:30:00.000Z', allDay: false, title: 'Overlap', company: null, kind: 'calendar', location: null },
      ],
    }),
    NOW
  );

  it('groups tasks by when they are due', () => {
    expect(day.overdue.map((t) => t.id)).toEqual(['late']);
    expect(day.overdue[0]!.lateDays).toBe(3);
    expect(day.dueToday.map((t) => t.id)).toEqual(['four', 'eod', 'sup']); // timed first
    expect(day.upcoming).toHaveLength(1);
    expect(day.upcoming[0]!.label).toBe('Friday 20 Nov');
    expect(day.onTheGo.map((t) => t.id)).toEqual(['go']); // untouched, undated work stays out
  });

  it('adds up free time, merging overlapping meetings', () => {
    expect(day.time.minutesLeft).toBe(540); // before 09:00 → the whole day
    expect(day.time.busyMinutes).toBe(90); // 10:00–11:30 Lagos, merged
    expect(day.time.freeMinutes).toBe(450);
    // Only what you own counts towards what today's work needs.
    expect(day.time.neededMinutes).toBe(180);
    expect(day.time.unestimated).toBe(1);
  });

  it('says it in a sentence', () => {
    expect(day.headline).toBe('You have 3 tasks due today, 1 overdue and 2 meetings. About 7h 30m of your working day is free, and today\'s work needs about 3h.');
    expect(day.firstName).toBe('Ayomide');
  });

  it('warns when the work does not fit', () => {
    const tight = assembleMyDay(inputs([task({ deadline: '2026-11-18T00:00:00.000Z', estimateMinutes: 600 })]), NOW);
    expect(tight.headline).toContain('needs about 10h: 1h more than you have');
  });

  it('says something useful on an empty day', () => {
    const quiet = assembleMyDay(inputs([task({ title: 'Brief', deadline: '2026-11-20T00:00:00.000Z' })]), NOW);
    expect(quiet.headline).toBe('Nothing is due today. Next up: Brief (Friday 20 Nov).');
  });

  it('busy minutes only count the working day still ahead', () => {
    const ev = [{ start: '2026-11-18T07:00:00.000Z', end: '2026-11-18T09:00:00.000Z', allDay: false, title: 'x', company: null, kind: 'calendar' as const, location: null }];
    expect(busyMinutesBetween(ev, '2026-11-18', 9 * 60, 18 * 60)).toBe(60); // 08:00–10:00 → 09:00–10:00
  });
});

describe('morning email', () => {
  const day = assembleMyDay(
    inputs([
      task({ id: 't1', title: 'Send <MOU> draft', deadline: '2026-11-18T15:00:00.000Z', deadlineHasTime: true, nextStep: 'Get legal sign-off', checklistDone: 1, checklistTotal: 3, priority: 'urgent' }),
      task({ id: 't2', title: 'Old thing', deadline: '2026-11-10T00:00:00.000Z' }),
    ], {
      team: [{ companyId: 'c1', company: 'ABION', blocked: [{ id: 'b1', title: 'QA pass', owner: 'Ngozi' }], lateByOthers: [], missingEod: ['Tunde'], missingEodDate: '2026-11-17' }],
    }),
    NOW
  );
  const mail = renderMyDayEmail(day, 'https://app.example.com');

  it('names the most pressing task in the subject', () => {
    expect(myDaySubject(day)).toBe('Your day, Wed 18 Nov: Send <MOU> draft + 1 more');
    expect(myDaySubject(day, true)).toMatch(/^Your week/);
  });
  it('lists tasks with when, progress and the next step — not just counts', () => {
    expect(mail.html).toContain('Send &lt;MOU&gt; draft'); // escaped
    expect(mail.html).toContain('by 4 pm, in 7h 55m');
    expect(mail.html).toContain('1/3 steps done');
    expect(mail.html).toContain('Get legal sign-off');
    expect(mail.html).toContain('8 days late');
    expect(mail.text).toContain('Next step: Get legal sign-off');
  });
  it('shows leaders who is stuck', () => {
    expect(mail.html).toContain('QA pass');
    expect(mail.html).toContain('No EOD Tuesday');
    expect(mail.text).toContain('- Blocked: QA pass (Ngozi)');
  });
  it('links each task into its own company', () => {
    expect(taskLink('https://app.example.com', { id: 't1', companyId: 'c1' })).toBe('https://app.example.com/work/my-tasks?task=t1&org=c1');
    expect(mail.html).toContain('/work/team-tasks?task=b1&amp;org=c1');
  });
});
