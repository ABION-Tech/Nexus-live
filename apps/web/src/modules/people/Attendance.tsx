import { useEffect, useState } from 'react';
import { Avatar, Badge, Card, LoadingState, ErrorState, EmptyState } from '../../components/ui';
import { fetchAttendance } from '../../services/eodService';
import type { AttendanceEntry } from '@nexus/shared';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// PRD §7.2 04 PEOPLE → Attendance. "EOD-day-aware — only flags members
// scheduled to report today" (§8.4) — GET /eod/attendance
// (eodService.ts's getAttendanceForDate) is exactly that set, each
// flagged present/absent by whether they've filed today's EOD. Read-only
// here — filing happens from Comms & Ops > EOD Report, not this view.
export function Attendance() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [entries, setEntries] = useState<AttendanceEntry[]>([]);

  function load_() {
    setLoad({ status: 'loading' });
    fetchAttendance()
      .then((rows) => {
        setEntries(rows);
        setLoad({ status: 'ready' });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setLoad({ status: 'error', message });
      });
  }

  useEffect(load_, []);

  return (
    <div className="nx-page nx-view-enter">
      <h2>Attendance — {todayIso()}</h2>
      {load.status === 'loading' && <LoadingState label="Loading attendance…" />}
      {load.status === 'error' && <ErrorState title="Couldn't load attendance" description={load.message} onRetry={load_} />}
      {load.status === 'ready' && entries.length === 0 && (
        <EmptyState title="No one is scheduled today" description="No team members have today in their EOD_Days." />
      )}
      {load.status === 'ready' && entries.length > 0 && (
        <div className="nx-stack nx-stack--sm">
          {entries.map((e) => (
            <Card key={e.userId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Avatar name={e.name} size="sm" />
                <span>{e.name}</span>
              </div>
              <Badge tone={e.filed ? 'success' : 'warning'} dot>
                {e.filed ? 'Filed' : 'Not filed yet'}
              </Badge>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
