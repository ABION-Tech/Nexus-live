// PRD §7.2 04 PEOPLE → Leave. GET /leave already auto-scopes to "your own"
// when the caller has no `leave.read` grant (routes/leave.ts, same check-4
// fallback tasks.ts/eod.ts use) — this page never needs to ask the server
// "am I a leader" first, it just always requests everything and shows
// whatever comes back. The "Team requests" tab is gated on `isLeader`
// purely as a UX convenience (ia.ts's own convention, see its header
// comment): a non-leader who somehow does hold a `leave.approve` grant
// would still succeed calling approve/reject directly, this tab just
// isn't surfaced for them since there's no bulk grants-fetch endpoint
// yet to ask the frontend "should I show this".
import { useEffect, useMemo, useState } from 'react';
import { Card, Button, Badge, Modal, Input, DatePicker, Tabs, LoadingState, ErrorState, EmptyState, useToast } from '../../components/ui';
import {
  approveLeaveRequest,
  cancelLeaveRequest,
  createLeaveRequest,
  fetchLeaveRequests,
  rejectLeaveRequest,
} from '../../services/leaveService';
import { fetchPeople } from '../../services/peopleService';
import type { LeaveRequest, LeaveRequestInput, LeaveStatus, Person } from '@nexus/shared';
import type { CurrentUser } from '../../services/authService';
import { ApiError } from '../../services/apiClient';

const STATUS_TONE: Record<LeaveStatus, 'warning' | 'success' | 'danger'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
};

const STATUS_LABEL: Record<LeaveStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function daysInclusive(startDate: string, endDate: string): number {
  const ms = new Date(endDate).getTime() - new Date(startDate).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

interface RequestFormState {
  startDate: string;
  endDate: string;
  reason: string;
}

const EMPTY_FORM: RequestFormState = { startDate: '', endDate: '', reason: '' };

export function Leave({ user }: { user: CurrentUser }) {
  const { show } = useToast();
  const isLeader = user.role === 'leader';
  const [tab, setTab] = useState<'mine' | 'team'>('mine');
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; requests: LeaveRequest[] }
  >({ status: 'loading' });
  const [people, setPeople] = useState<Person[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<RequestFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);

  function load() {
    setState({ status: 'loading' });
    fetchLeaveRequests()
      .then((requests) => setState({ status: 'ready', requests }))
      .catch((err: unknown) => setState({ status: 'error', message: errorMessage(err) }));
  }

  useEffect(load, []);
  useEffect(() => {
    if (isLeader) fetchPeople().then(setPeople).catch(() => setPeople([]));
  }, [isLeader]);

  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p] as const)), [people]);

  const mine = useMemo(() => {
    if (state.status !== 'ready') return [];
    return state.requests.filter((r) => r.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [state, user.id]);

  const team = useMemo(() => {
    if (state.status !== 'ready') return [];
    // Pending first, since that's the queue a leader actually acts on.
    return [...state.requests].sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (b.status === 'pending' && a.status !== 'pending') return 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [state]);

  async function handleCreate() {
    if (!form.startDate || !form.endDate) {
      show('Start and end date are required.', 'danger');
      return;
    }
    if (form.startDate > form.endDate) {
      show('Start date must be on or before the end date.', 'danger');
      return;
    }
    setSaving(true);
    try {
      const input: LeaveRequestInput = { startDate: form.startDate, endDate: form.endDate, reason: form.reason || undefined };
      await createLeaveRequest(input);
      show('Leave request submitted.', 'success');
      setModalOpen(false);
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function handleCancel(id: string) {
    setActingId(id);
    try {
      await cancelLeaveRequest(id);
      show('Request cancelled.', 'default');
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setActingId(null);
    }
  }

  async function handleApprove(id: string) {
    setActingId(id);
    try {
      await approveLeaveRequest(id);
      show('Approved.', 'success');
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setActingId(null);
    }
  }

  async function handleReject(id: string) {
    setActingId(id);
    try {
      await rejectLeaveRequest(id);
      show('Rejected.', 'default');
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setActingId(null);
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading leave requests…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load leave requests" description={state.message} onRetry={load} />;

  const rows = tab === 'mine' ? mine : team;

  return (
    <div className="nx-dashboard-overview">
      <div className="nx-app-main__header" style={{ padding: 0, marginBottom: 16 }}>
        <h1>Leave</h1>
        <Button size="sm" onClick={() => setModalOpen(true)}>Request leave</Button>
      </div>

      {isLeader && (
        <div style={{ marginBottom: 16 }}>
          <Tabs
            items={[
              { key: 'mine', label: 'My requests' },
              { key: 'team', label: 'Team requests' },
            ]}
            active={tab}
            onChange={(k) => setTab(k as 'mine' | 'team')}
          />
        </div>
      )}

      <Card>
        {rows.length === 0 && (
          <EmptyState
            title={tab === 'mine' ? 'No leave requests yet' : 'No leave requests from the team'}
            description={tab === 'mine' ? 'Request time off and it will show up here.' : 'Nothing has been requested yet.'}
          />
        )}
        <div className="nx-stack nx-stack--sm">
          {rows.map((r) => (
            <div
              key={r.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 12,
                padding: '12px 0',
                borderBottom: '1px solid var(--nx-border, #eee)',
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {tab === 'team' && (
                    <strong>{peopleById.get(r.userId)?.name ?? (r.userId === user.id ? 'You' : r.userId)}</strong>
                  )}
                  <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                </div>
                <div style={{ marginTop: 4, fontSize: 14 }}>
                  {r.startDate} → {r.endDate}{' '}
                  <span style={{ opacity: 0.7 }}>
                    ({daysInclusive(r.startDate, r.endDate)} day{daysInclusive(r.startDate, r.endDate) === 1 ? '' : 's'})
                  </span>
                </div>
                {r.reason && <p style={{ marginTop: 4, opacity: 0.8, fontSize: 14 }}>{r.reason}</p>}
                {r.status !== 'pending' && r.decisionNote && (
                  <p style={{ marginTop: 4, fontSize: 13, opacity: 0.7 }}><em>Note: {r.decisionNote}</em></p>
                )}
              </div>

              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                {tab === 'mine' && r.status === 'pending' && (
                  <Button size="sm" variant="ghost" disabled={actingId !== null} onClick={() => handleCancel(r.id)}>
                    Cancel
                  </Button>
                )}
                {tab === 'team' && r.status === 'pending' && (
                  <>
                    <Button size="sm" disabled={actingId !== null} onClick={() => handleApprove(r.id)}>
                      Approve
                    </Button>
                    <Button size="sm" variant="secondary" disabled={actingId !== null} onClick={() => handleReject(r.id)}>
                      Reject
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Request leave">
        <div className="nx-stack nx-stack--md">
          <DatePicker
            label="Start date"
            value={form.startDate}
            required
            onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
          />
          <DatePicker
            label="End date"
            value={form.endDate}
            required
            onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
          />
          <Input
            label="Reason (optional)"
            value={form.reason}
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <Button type="button" variant="ghost" disabled={saving} onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={saving} onClick={handleCreate}>
              Submit request
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
