// Session 62 — GET /overview/my-day: your day across every company you're
// in (apps/api/src/services/myDayService.ts). The same data the morning
// email sends.
import { apiClient } from './apiClient';

export interface DayTask {
  id: string;
  title: string;
  companyId: string;
  company: string;
  priority: string;
  status: string;
  role: 'owner' | 'support' | 'supervisor';
  deadline: string | null;
  deadlineHasTime: boolean;
  startDate: string | null;
  estimateMinutes: number | null;
  nextStep: string | null;
  checklistDone: number;
  checklistTotal: number;
  lateDays?: number;
}

export interface DayEvent {
  start: string;
  end: string | null;
  allDay: boolean;
  title: string;
  company: string | null;
  kind: 'meeting' | 'calendar';
  location: string | null;
}

export interface TeamWatch {
  companyId: string;
  company: string;
  blocked: { id: string; title: string; owner: string | null }[];
  lateByOthers: { id: string; title: string; owner: string | null; lateDays: number }[];
  missingEod: string[];
  missingEodDate: string;
}

export interface MyDay {
  date: string;
  dateLabel: string;
  generatedAt: string;
  name: string;
  firstName: string;
  companies: { id: string; name: string }[];
  headline: string;
  events: DayEvent[];
  overdue: DayTask[];
  dueToday: DayTask[];
  onTheGo: DayTask[];
  upcoming: { date: string; label: string; tasks: DayTask[] }[];
  time: {
    workdayStart: string;
    workdayEnd: string;
    minutesLeft: number;
    busyMinutes: number;
    freeMinutes: number;
    neededMinutes: number;
    unestimated: number;
  };
  team: TeamWatch[];
  more: { overdue: number; dueToday: number; onTheGo: number };
}

export const fetchMyDay = () => apiClient.get<MyDay>('/overview/my-day');

const TZ = 'Africa/Lagos';

export function fmtMinutes(m: number): string {
  if (m <= 0) return '0m';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
}

export function fmtClock(iso: string): string {
  return new Date(iso)
    .toLocaleTimeString('en-GB', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(':00', '')
    .replace(' ', ' ');
}

function lagosDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

/** Minutes since midnight in Lagos. */
export function lagosMinutes(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  return Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60 + Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
}

/** Mirrors the API's dueText, recomputed against the live clock. */
export function dueText(t: DayTask, today: string, now = new Date()): string {
  if (!t.deadline) return '';
  if (t.lateDays && t.lateDays > 0) return `${t.lateDays} day${t.lateDays === 1 ? '' : 's'} late`;
  const dl = new Date(t.deadline);
  const date = lagosDate(dl);
  if (date !== today) {
    const diff = Math.round((Date.parse(date + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86_400_000);
    if (diff === 1) return 'due tomorrow';
    return 'due ' + new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  if (!t.deadlineHasTime) return 'by end of day';
  const mins = Math.round((dl.getTime() - now.getTime()) / 60000);
  if (mins < 0) return `was due ${fmtClock(t.deadline)}`;
  return `by ${fmtClock(t.deadline)}, in ${fmtMinutes(mins)}`;
}
