// Session 60 (C-04) — "next run" times, and the guard that keeps the app's
// copy of the schedule (packages/shared AUTOMATION_SCHEDULE) identical to
// the scheduler's own (apps/scheduler/src/jobs.ts), which deliberately
// doesn't import app code.
import { describe, expect, it } from 'vitest';
import { AUTOMATION_CONTROL_KEYS, AUTOMATION_SCHEDULE, nextCronRun } from '@nexus/shared';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read as text, not imported: apps/api's tsconfig can't include another
// package's source, and the scheduler is meant to stay standalone.
const JOBS_TS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../scheduler/src/jobs.ts'), 'utf8');
const SCHEDULER_CRON = Object.fromEntries(
  [...JOBS_TS.matchAll(/name: '([a-z_]+)',[^}]*?cron: '([^']+)'/g)].map((m) => [m[1], m[2]])
);

describe('nextCronRun (Africa/Lagos, UTC+1)', () => {
  it('later today', () => {
    // 10:30 Lagos → 16:00 Lagos the same day = 15:00 UTC
    expect(nextCronRun('0 16 * * *', new Date('2026-11-15T09:30:00Z'))?.toISOString()).toBe('2026-11-15T15:00:00.000Z');
  });
  it('tomorrow once today has passed, and never the same minute', () => {
    expect(nextCronRun('0 8 * * *', new Date('2026-11-15T07:00:00Z'))?.toISOString()).toBe('2026-11-16T07:00:00.000Z');
  });
  it('minutes past the hour', () => {
    expect(nextCronRun('5 18 * * *', new Date('2026-11-15T17:01:00Z'))?.toISOString()).toBe('2026-11-15T17:05:00.000Z');
  });
  it('weekdays only, hourly in a window', () => {
    // Sat 21 Nov 2026 12:00 Lagos → Mon 23 Nov 08:00 Lagos
    expect(nextCronRun('0 8-19 * * 1-5', new Date('2026-11-21T11:00:00Z'))?.toISOString()).toBe('2026-11-23T07:00:00.000Z');
    // Mon 23 Nov 10:20 Lagos → 11:00 Lagos
    expect(nextCronRun('0 8-19 * * 1-5', new Date('2026-11-23T09:20:00Z'))?.toISOString()).toBe('2026-11-23T10:00:00.000Z');
  });
  it('steps and lists', () => {
    expect(nextCronRun('*/30 * * * *', new Date('2026-11-15T10:10:00Z'))?.toISOString()).toBe('2026-11-15T10:30:00.000Z');
    expect(nextCronRun('15,45 9 * * *', new Date('2026-11-15T08:20:00Z'))?.toISOString()).toBe('2026-11-15T08:45:00.000Z');
  });
  it('rejects malformed expressions', () => {
    expect(() => nextCronRun('0 25 * * *')).toThrow();
    expect(() => nextCronRun('0 8 * *')).toThrow();
  });
});

describe('schedule parity with the scheduler service', () => {
  it('every key has the same cron in both places', () => {
    expect(Object.keys(SCHEDULER_CRON).length).toBeGreaterThanOrEqual(AUTOMATION_CONTROL_KEYS.length);
    for (const key of AUTOMATION_CONTROL_KEYS) expect([key, AUTOMATION_SCHEDULE[key]]).toEqual([key, SCHEDULER_CRON[key]]);
  });
});
