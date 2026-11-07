// PRD §8.10 Automation — toggle panel + cron job health, both halves.
//
// Health (last run / last result) is real as of Phase H
// (0024_automation_scheduling.sql / routes/automationMaintenance.ts):
// fetched best-effort alongside the controls and rendered per-row below.
// Two of the nine jobs (daily_recurring_tasks, hourly_follow_up) still
// have no implementation at all — not a wiring gap, a schema gap (PRD
// §12 describes both against columns that don't exist in this database;
// see automationJobs.ts's own UNIMPLEMENTED_JOBS) — those render as
// "Not yet implemented" rather than a fabricated run.
//
// Permissions: this page fetches controls and renders them; if the API
// returns 403 the ErrorState covers it. The toggle itself is disabled
// server-side for callers without automation.update — if a user with
// read-only lands here, the toggle will visually fail and revert on the
// first PATCH attempt (same pattern as Leave.tsx's approval buttons for
// non-approvers). A read-only guard UI is overkill until RBAC is surfaced
// to the session on the client side.
import { useEffect, useState } from 'react';
import { Card, LoadingState, ErrorState, useToast } from '../../components/ui';
import {
  fetchAutomationControls,
  fetchAutomationHealth,
  fetchAutomationLog,
  toggleAutomationControl,
} from '../../services/automationService';
import type { AutomationControl, AutomationControlKey, AutomationHealthEntry, AutomationLogEntry } from '@nexus/shared';

// ─── Job metadata ────────────────────────────────────────────────────────────
// Label / schedule / description per PRD §12 table — kept here rather than
// in the shared package because they're presentational concerns, not data.
interface JobMeta {
  label: string;
  schedule: string;
  description: string;
}

const JOB_META: Record<AutomationControlKey, JobMeta> = {
  daily_overdue_check: {
    label: 'Overdue Check',
    schedule: '08:00 daily',
    description: 'Flags tasks that passed their due date and pushes them to the attention queue.',
  },
  daily_morning_digest: {
    label: 'Morning Digest',
    schedule: '08:00 daily (Mon full · Tue–Fri light)',
    description: 'Sends a personalised summary of open tasks, goals, and follow-ups to each member.',
  },
  daily_dependency_sweep: {
    label: 'Dependency Sweep',
    schedule: '09:00 daily',
    description: 'Detects blocked tasks whose upstream dependency was completed and updates their status.',
  },
  daily_recurring_tasks: {
    label: 'Recurring Tasks',
    schedule: '10:00 daily',
    description: 'Spawns the next occurrence of any recurring task whose recurrence date has arrived.',
  },
  daily_cob_reminders: {
    label: 'COB Reminders',
    schedule: '16:00 daily (EOD-day-aware)',
    description: 'Nudges members with open tasks due today before close of business.',
  },
  daily_follow_up_escalation: {
    label: 'Follow-up Escalation',
    schedule: '18:00 daily',
    description: 'Escalates stale follow-ups and deadline-breached items to the responsible member\'s manager.',
  },
  daily_eod_nudge: {
    label: 'EOD Nudge',
    schedule: '18:00 daily',
    description: 'Reminds members who haven\'t submitted their end-of-day report to do so before cutoff.',
  },
  daily_task_snapshot: {
    label: 'Task Snapshot',
    schedule: '23:00 daily',
    description: 'Records a daily point-in-time snapshot of task counts for the analytics trend charts.',
  },
  hourly_follow_up: {
    label: 'Hourly Follow-ups',
    schedule: 'Hourly, 08:00–19:00 weekdays',
    description: 'Runs follow-up dispatch on the hour during working hours — catches items that need same-day action.',
  },
};

// ─── Toggle switch ────────────────────────────────────────────────────────────
function ToggleSwitch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        width: 44,
        height: 24,
        borderRadius: 999,
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? 'var(--accent)' : 'var(--surface-raised)',
        outline: 'none',
        transition: 'background 0.18s',
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
        boxShadow: `inset 0 0 0 1px ${checked ? 'var(--accent)' : 'var(--border-strong)'}`,
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: checked ? 22 : 2,
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 0.18s',
          boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
        }}
      />
    </button>
  );
}

// ─── Relative time helper ─────────────────────────────────────────────────────
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ─── Health badge ─────────────────────────────────────────────────────────────
// Renders the four real states GET /automation/health can report for a
// job: not implemented (schema gap, not a wiring gap), never run yet
// (implemented, but the external scheduler hasn't hit it), last run
// succeeded, last run errored. No fifth "currently running" state —
// this endpoint has no concept of an in-flight run, only completed ones.
function HealthBadge({ health }: { health: AutomationHealthEntry | undefined }) {
  if (!health || !health.implemented) {
    return (
      <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
        Not yet implemented
      </span>
    );
  }
  if (!health.lastRun) {
    return (
      <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
        Not yet run
      </span>
    );
  }
  const ok = health.lastRun.status === 'success';
  return (
    <span
      style={{
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        color: ok ? 'var(--success)' : 'var(--danger)',
      }}
      title={health.lastRun.error ?? undefined}
    >
      {ok ? '✓' : '✗'} {ok ? 'Ran' : 'Failed'} {relativeTime(health.lastRun.finishedAt)}
    </span>
  );
}

// ─── Single toggle row ────────────────────────────────────────────────────────
function ControlRow({
  control,
  onToggle,
  pending,
  health,
}: {
  control: AutomationControl;
  onToggle: (key: AutomationControlKey, next: boolean) => void;
  pending: boolean;
  health: AutomationHealthEntry | undefined;
}) {
  const meta = JOB_META[control.key as AutomationControlKey];
  if (!meta) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 16,
        padding: '16px 0',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {/* Left: label + schedule + description */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{meta.label}</span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--muted)',
              background: 'var(--surface-raised)',
              padding: '2px 7px',
              borderRadius: 4,
              whiteSpace: 'nowrap',
            }}
          >
            {meta.schedule}
          </span>
        </div>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          {meta.description}
        </p>
        {control.updatedAt && (
          <p
            style={{
              margin: '5px 0 0',
              fontSize: 11,
              color: 'var(--muted)',
              fontFamily: 'var(--font-mono)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <span>
              {control.enabled ? 'Enabled' : 'Disabled'} · updated {relativeTime(control.updatedAt)}
            </span>
            <span style={{ opacity: 0.5 }}>·</span>
            <HealthBadge health={health} />
          </p>
        )}
      </div>

      {/* Right: toggle */}
      <div style={{ display: 'flex', alignItems: 'center', paddingTop: 2 }}>
        <ToggleSwitch
          checked={control.enabled}
          disabled={pending}
          onChange={(next) => onToggle(control.key as AutomationControlKey, next)}
          label={`${meta.label}: ${control.enabled ? 'enabled' : 'disabled'}`}
        />
      </div>
    </div>
  );
}

// ─── Audit log section ────────────────────────────────────────────────────────
function AuditLog() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AutomationLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { show } = useToast();

  function load() {
    setLoading(true);
    setErr(null);
    fetchAutomationLog(30)
      .then(setEntries)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : 'Could not load audit log.';
        setErr(msg);
        show(msg, 'danger');
      })
      .finally(() => setLoading(false));
  }

  function toggle() {
    if (!open && entries.length === 0 && !loading) load();
    setOpen((v) => !v);
  }

  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        onClick={toggle}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--accent)',
          fontSize: 13,
          cursor: 'pointer',
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
        }}
      >
        {open ? '▾' : '▸'} Audit log — last 30 changes
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          {loading && (
            <p style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
              Loading…
            </p>
          )}
          {err && (
            <p style={{ fontSize: 12, color: 'var(--danger)', fontFamily: 'var(--font-mono)' }}>
              {err}
            </p>
          )}
          {!loading && !err && entries.length === 0 && (
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>No changes recorded yet.</p>
          )}
          {entries.length > 0 && (
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                overflow: 'hidden',
              }}
            >
              {entries.map((e) => {
                const meta = JOB_META[e.controlKey as AutomationControlKey];
                return (
                  <div
                    key={e.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto auto',
                      gap: 12,
                      alignItems: 'center',
                      padding: '9px 14px',
                      borderBottom: '1px solid var(--border)',
                      fontSize: 12,
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {meta?.label ?? e.controlKey}
                    </span>
                    <span
                      style={{
                        color: e.newValue ? 'var(--success)' : 'var(--danger)',
                        fontWeight: 700,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {e.previousValue === null ? '' : `${e.previousValue ? 'ON' : 'OFF'} → `}
                      {e.newValue ? 'ON' : 'OFF'}
                    </span>
                    <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                      {relativeTime(e.changedAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {!loading && entries.length > 0 && (
            <button
              type="button"
              onClick={load}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--muted)',
                fontSize: 11,
                cursor: 'pointer',
                marginTop: 6,
                fontFamily: 'var(--font-mono)',
              }}
            >
              ↻ Refresh
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

export function AutomationToggles() {
  const { show } = useToast();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [controls, setControls] = useState<AutomationControl[]>([]);
  // Health is fetched independently of the controls load/error state and
  // defaults to an empty map on failure — it's supplementary data for
  // each row, not something that should block the toggle panel (the
  // page's actual primary function) from rendering.
  const [health, setHealth] = useState<Record<string, AutomationHealthEntry>>({});
  // Set of keys currently mid-PATCH — prevents double-flips.
  const [pending, setPending] = useState<Set<string>>(new Set());

  function load() {
    setState({ status: 'loading' });
    fetchAutomationControls()
      .then((list) => {
        setControls(list);
        setState({ status: 'ready' });
      })
      .catch((err: unknown) => {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Could not load automation controls.',
        });
      });
  }

  function loadHealth() {
    fetchAutomationHealth()
      .then((entries) => {
        setHealth(Object.fromEntries(entries.map((e) => [e.key, e])));
      })
      .catch(() => {
        // Best-effort — HealthBadge already renders a reasonable default
        // (nothing / "Not yet run") when a key has no entry, so a failed
        // fetch here just means every row falls back to that, not an
        // error banner over the whole page.
      });
  }

  useEffect(load, []);
  useEffect(loadHealth, []);

  async function handleToggle(key: AutomationControlKey, next: boolean) {
    // Optimistic update — flip the control immediately; revert on failure.
    setControls((prev) =>
      prev.map((c) => (c.key === key ? { ...c, enabled: next } : c))
    );
    setPending((prev) => new Set(prev).add(key));

    try {
      const updated = await toggleAutomationControl(key, next);
      // Merge the server's authoritative record (updatedAt etc.).
      setControls((prev) => prev.map((c) => (c.key === key ? updated : c)));
      show(`${JOB_META[key]?.label ?? key} ${next ? 'enabled' : 'disabled'}.`, 'success');
    } catch (err: unknown) {
      // Revert.
      setControls((prev) =>
        prev.map((c) => (c.key === key ? { ...c, enabled: !next } : c))
      );
      show(err instanceof Error ? err.message : 'Toggle failed — please try again.', 'danger');
    } finally {
      setPending((prev) => {
        const next2 = new Set(prev);
        next2.delete(key);
        return next2;
      });
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading automation controls…" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        title="Couldn't load automation controls"
        description={state.message}
        onRetry={load}
      />
    );
  }

  const enabledCount = controls.filter((c) => c.enabled).length;

  return (
    <div className="nx-page nx-page--narrow nx-view-enter" style={{ maxWidth: 700 }}>
      {/* Header */}
      <div>
        <h2>Automation</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
          {enabledCount} of {controls.length} scheduled jobs active.
          Toggle any job to enable or disable it org-wide — changes take effect at the next scheduled run.
        </p>
      </div>

      {/* Note: 2 of 9 jobs have no implementation yet — schema gap, not a
          wiring gap. See each row's own "Not yet implemented" badge. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '10px 14px',
          background: 'var(--info-bg)',
          border: '1px solid rgba(91,82,240,0.25)',
          borderRadius: 'var(--radius)',
          fontSize: 12,
          color: 'var(--text-dim)',
        }}
      >
        <span style={{ color: 'var(--accent)', fontSize: 16, lineHeight: 1 }}>ℹ</span>
        <span>
          <strong style={{ color: 'var(--accent)' }}>Recurring Tasks and Hourly Follow-ups aren't built yet —</strong>{' '}
          both depend on database columns (a recurrence template, a per-task follow-up interval) that don't exist
          in this schema yet. Every other job below runs on its own schedule and reports real last-run status.
        </span>
      </div>

      {/* Toggle panel */}
      <Card style={{ padding: '0 20px' }}>
        {controls.map((control) => (
          <ControlRow
            key={control.key}
            control={control}
            onToggle={handleToggle}
            pending={pending.has(control.key)}
            health={health[control.key]}
          />
        ))}
        {/* Remove bottom border from last row */}
        <style>{`
          .automation-panel > :last-child { border-bottom: none; }
        `}</style>
      </Card>

      {/* Audit log */}
      <AuditLog />
    </div>
  );
}
