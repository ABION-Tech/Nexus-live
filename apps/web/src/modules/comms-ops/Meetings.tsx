// PRD §8.2 Meetings — /comms-ops/meetings. Added as a new Comms & Ops
// subsection (ia.ts's own precedent for this: "Company Docs... added as
// a subsection here rather than a new top-level IA section" — Comms &
// Ops is the closest existing section by shape, since a meeting's
// agenda/notes/recording is an operational record, not a calendar sync
// concern). Deliberately NOT folded into the existing "Calendar /
// Meetings" subsection at /comms-ops/calendar — that page is Work's own
// Calendar.tsx (Google Calendar event sync, PRD §10.5), a different
// resource with a different backend; this page is the meetings table
// itself (meetingService.ts/meetings.ts), including the agenda/invitee/
// external-attendee fields and the recording-matching review queue that
// have no other home in the app yet.
//
// Three tabs, same shape as Leave.tsx's "mine"/"team" split:
//   'upcoming' / 'past'  — plain list, split client-side on startTime
//                          vs now since the API has no such filter itself
//   'needs-review'       — meetingRecordingService.ts's unmatched/
//                          ambiguous queue; a human links each row to the
//                          correct meeting here (never auto-resolved,
//                          see that service's own header for why)
import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Badge,
  Modal,
  Input,
  Select,
  Checkbox,
  Tabs,
  LoadingState,
  ErrorState,
  EmptyState,
  Table,
  useToast,
} from '../../components/ui';
import {
  archiveMeeting,
  createMeeting,
  fetchMeetingRecordings,
  fetchMeetings,
  fetchRecordingsNeedingReview,
  linkRecordingToMeeting,
  restoreMeeting,
  updateMeeting,
} from '../../services/meetingService';
import { fetchPeople } from '../../services/peopleService';
import type { CreateMeetingInput, Meeting, MeetingLocationType, MeetingRecording, Person } from '@nexus/shared';
import { ApiError } from '../../services/apiClient';

const LOCATION_OPTIONS: { value: MeetingLocationType; label: string }[] = [
  { value: 'physical', label: 'In person' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'google_meet', label: 'Google Meet' },
];

const LOCATION_LABEL: Record<MeetingLocationType, string> = {
  physical: 'In person',
  zoom: 'Zoom',
  google_meet: 'Google Meet',
};

const SOURCE_LABEL: Record<MeetingRecording['source'], string> = {
  zoom: 'Zoom',
  google_meet: 'Google Meet',
  fireflies: 'Fireflies',
};

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

// <input type="datetime-local"> expects "yyyy-MM-ddTHH:mm" in local time,
// same helper Work's Calendar.tsx already uses for the same reason.
function toDateTimeLocalValue(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

interface FormState {
  title: string;
  locationType: MeetingLocationType;
  locationDetail: string;
  startAt: string;
  endAt: string;
  organizerUserId: string;
  zoomMeetingId: string;
  agenda: string;
  inviteeUserIds: string[];
  externalEmails: string;
  notes: string;
}

function emptyForm(defaultOrganizerId: string): FormState {
  return {
    title: '',
    locationType: 'physical',
    locationDetail: '',
    startAt: '',
    endAt: '',
    organizerUserId: defaultOrganizerId,
    zoomMeetingId: '',
    agenda: '',
    inviteeUserIds: [],
    externalEmails: '',
    notes: '',
  };
}

function formFromMeeting(m: Meeting): FormState {
  return {
    title: m.title,
    locationType: m.locationType,
    locationDetail: m.locationDetail ?? '',
    startAt: toDateTimeLocalValue(m.startTime),
    endAt: toDateTimeLocalValue(m.endTime),
    organizerUserId: m.organizerUserId ?? '',
    zoomMeetingId: m.zoomMeetingId ?? '',
    agenda: m.agenda ?? '',
    inviteeUserIds: m.inviteeUserIds ?? [],
    externalEmails: m.externalEmails ?? '',
    notes: m.notes ?? '',
  };
}

export function Meetings({ user }: { user: { id: string } }) {
  const { show } = useToast();
  const [tab, setTab] = useState<'upcoming' | 'past' | 'needs-review'>('upcoming');
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; meetings: Meeting[] }
  >({ status: 'loading' });
  const [reviewState, setReviewState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; recordings: MeetingRecording[] }
  >({ status: 'loading' });
  const [people, setPeople] = useState<Person[]>([]);
  const [drawer, setDrawer] = useState<{ mode: 'create' } | { mode: 'edit'; meeting: Meeting } | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm(user.id));
  const [saving, setSaving] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [linkChoice, setLinkChoice] = useState<Record<string, string>>({});
  const [drawerRecordings, setDrawerRecordings] = useState<MeetingRecording[]>([]);

  function load() {
    setState({ status: 'loading' });
    fetchMeetings({ includeArchived: true })
      .then((meetings) => setState({ status: 'ready', meetings }))
      .catch((err: unknown) => setState({ status: 'error', message: errorMessage(err) }));
  }

  function loadReview() {
    setReviewState({ status: 'loading' });
    fetchRecordingsNeedingReview()
      .then((recordings) => setReviewState({ status: 'ready', recordings }))
      .catch((err: unknown) => setReviewState({ status: 'error', message: errorMessage(err) }));
  }

  useEffect(load, []);
  useEffect(loadReview, []);
  useEffect(() => {
    fetchPeople().then(setPeople).catch(() => setPeople([]));
  }, []);

  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p] as const)), [people]);
  const peopleOptions = useMemo(() => people.map((p) => ({ value: p.id, label: p.name })), [people]);

  const { upcoming, past } = useMemo(() => {
    if (state.status !== 'ready') return { upcoming: [] as Meeting[], past: [] as Meeting[] };
    const now = Date.now();
    const active = state.meetings.filter((m) => !m.archivedAt);
    const archived = state.meetings.filter((m) => m.archivedAt);
    const upcomingActive = active
      .filter((m) => new Date(m.startTime).getTime() >= now)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
    const pastActive = active
      .filter((m) => new Date(m.startTime).getTime() < now)
      .sort((a, b) => b.startTime.localeCompare(a.startTime));
    // Archived meetings show up alongside past ones — same "archive, never
    // hard-delete" model meetingService.ts describes; a restore action is
    // how they come back, not a separate hidden tab nobody would check.
    return { upcoming: upcomingActive, past: [...pastActive, ...archived.sort((a, b) => b.startTime.localeCompare(a.startTime))] };
  }, [state]);

  function openCreate() {
    setForm(emptyForm(user.id));
    setDrawer({ mode: 'create' });
    setDrawerRecordings([]);
  }

  function openEdit(meeting: Meeting) {
    setForm(formFromMeeting(meeting));
    setDrawer({ mode: 'edit', meeting });
    setDrawerRecordings([]);
    fetchMeetingRecordings(meeting.id).then(setDrawerRecordings).catch(() => setDrawerRecordings([]));
  }

  function toggleInvitee(userId: string) {
    setForm((f) => ({
      ...f,
      inviteeUserIds: f.inviteeUserIds.includes(userId)
        ? f.inviteeUserIds.filter((id) => id !== userId)
        : [...f.inviteeUserIds, userId],
    }));
  }

  async function handleSave() {
    if (!form.title.trim()) {
      show('Title is required.', 'danger');
      return;
    }
    if (!form.startAt) {
      show('Start time is required.', 'danger');
      return;
    }
    const input: CreateMeetingInput = {
      title: form.title.trim(),
      locationType: form.locationType,
      locationDetail: form.locationDetail || undefined,
      startTime: new Date(form.startAt).toISOString(),
      endTime: form.endAt ? new Date(form.endAt).toISOString() : undefined,
      organizerUserId: form.organizerUserId || undefined,
      zoomMeetingId: form.locationType === 'zoom' ? form.zoomMeetingId || undefined : undefined,
      agenda: form.agenda || undefined,
      inviteeUserIds: form.inviteeUserIds,
      externalEmails: form.externalEmails || undefined,
      notes: form.notes || undefined,
    };
    setSaving(true);
    try {
      if (drawer?.mode === 'edit') {
        await updateMeeting(drawer.meeting.id, input);
        show('Meeting updated.', 'success');
      } else {
        await createMeeting(input);
        show('Meeting scheduled.', 'success');
      }
      setDrawer(null);
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive(id: string) {
    setActingId(id);
    try {
      await archiveMeeting(id);
      show('Meeting archived.', 'default');
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setActingId(null);
    }
  }

  async function handleRestore(id: string) {
    setActingId(id);
    try {
      await restoreMeeting(id);
      show('Meeting restored.', 'success');
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setActingId(null);
    }
  }

  async function handleLink(recordingId: string) {
    const meetingId = linkChoice[recordingId];
    if (!meetingId) {
      show('Choose which meeting this recording belongs to first.', 'danger');
      return;
    }
    setActingId(recordingId);
    try {
      await linkRecordingToMeeting(recordingId, meetingId);
      show('Recording linked.', 'success');
      loadReview();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setActingId(null);
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading meetings…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load meetings" description={state.message} onRetry={load} />;

  const rows = tab === 'upcoming' ? upcoming : tab === 'past' ? past : [];
  const reviewCount = reviewState.status === 'ready' ? reviewState.recordings.length : 0;

  return (
    <div className="nx-dashboard-overview">
      <div className="nx-app-main__header" style={{ padding: 0, marginBottom: 16 }}>
        <h1>Meetings</h1>
        <Button size="sm" onClick={openCreate}>Schedule meeting</Button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <Tabs
          items={[
            { key: 'upcoming', label: `Upcoming (${upcoming.length})` },
            { key: 'past', label: `Past (${past.length})` },
            { key: 'needs-review', label: `Needs review${reviewCount ? ` (${reviewCount})` : ''}` },
          ]}
          active={tab}
          onChange={(k) => setTab(k as typeof tab)}
        />
      </div>

      {tab !== 'needs-review' ? (
        <Card>
          {rows.length === 0 ? (
            <EmptyState
              title={tab === 'upcoming' ? 'No upcoming meetings' : 'No past meetings'}
              description={tab === 'upcoming' ? 'Schedule one and it will show up here.' : 'Nothing has happened yet.'}
            />
          ) : (
            <Table
              columns={[
                { key: 'title', header: 'Meeting', render: (m: Meeting) => (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <strong>{m.title}</strong>
                    {m.archivedAt && <Badge tone="neutral">Archived</Badge>}
                  </div>
                ) },
                { key: 'when', header: 'When', render: (m: Meeting) => formatWhen(m.startTime) },
                { key: 'location', header: 'Location', render: (m: Meeting) => (
                  <>
                    {LOCATION_LABEL[m.locationType]}
                    {m.locationDetail && <span style={{ opacity: 0.7 }}> · {m.locationDetail}</span>}
                  </>
                ) },
                { key: 'organizer', header: 'Organizer', render: (m: Meeting) =>
                  m.organizerUserId ? (peopleById.get(m.organizerUserId)?.name ?? 'Unknown') : '—' },
                { key: 'invitees', header: 'Invitees', render: (m: Meeting) => m.inviteeUserIds?.length || '—' },
                { key: 'actions', header: '', render: (m: Meeting) => (
                  <div style={{ display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(m)}>Edit</Button>
                    {m.archivedAt ? (
                      <Button size="sm" variant="secondary" disabled={actingId !== null} onClick={() => handleRestore(m.id)}>
                        Restore
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" disabled={actingId !== null} onClick={() => handleArchive(m.id)}>
                        Archive
                      </Button>
                    )}
                  </div>
                ) },
              ]}
              rows={rows}
              rowKey={(m) => m.id}
              onRowClick={openEdit}
            />
          )}
        </Card>
      ) : (
        <Card>
          {reviewState.status === 'loading' && <LoadingState label="Loading recordings…" />}
          {reviewState.status === 'error' && (
            <ErrorState title="Couldn't load the review queue" description={reviewState.message} onRetry={loadReview} />
          )}
          {reviewState.status === 'ready' && reviewState.recordings.length === 0 && (
            <EmptyState
              title="Nothing needs review"
              description="Recordings that couldn't be automatically matched to a meeting will show up here."
            />
          )}
          {reviewState.status === 'ready' && reviewState.recordings.length > 0 && (
            <div className="nx-stack nx-stack--sm">
              {reviewState.recordings.map((r) => (
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
                      <Badge tone={r.matchStatus === 'ambiguous' ? 'warning' : 'neutral'}>
                        {r.matchStatus === 'ambiguous' ? 'Ambiguous' : 'Unmatched'}
                      </Badge>
                      <span>{SOURCE_LABEL[r.source]}</span>
                    </div>
                    <div style={{ marginTop: 4, fontSize: 14, opacity: 0.8 }}>
                      {r.callStartTime ? formatWhen(r.callStartTime) : 'No call time reported'}
                    </div>
                    {r.matchStatus === 'ambiguous' && r.candidateMeetingIds.length > 0 && (
                      <p style={{ marginTop: 4, fontSize: 13, opacity: 0.7 }}>
                        Overlaps {r.candidateMeetingIds.length} meetings on this organizer's calendar — pick the right one below.
                      </p>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                    <Select
                      placeholder="Choose meeting…"
                      value={linkChoice[r.id] ?? ''}
                      onChange={(e) => setLinkChoice((c) => ({ ...c, [r.id]: e.target.value }))}
                      options={(state.status === 'ready' ? state.meetings : [])
                        .filter((m) => !m.archivedAt)
                        .map((m) => ({ value: m.id, label: `${m.title} · ${formatWhen(m.startTime)}` }))}
                    />
                    <Button size="sm" disabled={actingId !== null} onClick={() => handleLink(r.id)}>
                      Link
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Modal open={drawer !== null} onClose={() => setDrawer(null)} title={drawer?.mode === 'edit' ? 'Edit meeting' : 'Schedule meeting'}>
        <div className="nx-stack nx-stack--md">
          <Input label="Title" value={form.title} required onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />

          {drawer?.mode === 'edit' && drawerRecordings.length > 0 && (
            <div className="nx-field">
              <label className="nx-field__label">Linked recordings</label>
              <div className="nx-stack nx-stack--sm">
                {drawerRecordings.map((r) => (
                  <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                    <Badge tone="success">{SOURCE_LABEL[r.source]}</Badge>
                    {r.recordingUrl && (
                      <a href={r.recordingUrl} target="_blank" rel="noreferrer">Recording</a>
                    )}
                    {r.transcriptUrl && (
                      <a href={r.transcriptUrl} target="_blank" rel="noreferrer">Transcript</a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input
              type="datetime-local"
              label="Start"
              value={form.startAt}
              onChange={(e) => setForm((f) => ({ ...f, startAt: e.target.value }))}
            />
            <Input
              type="datetime-local"
              label="End (optional)"
              value={form.endAt}
              onChange={(e) => setForm((f) => ({ ...f, endAt: e.target.value }))}
            />
          </div>

          <Select
            label="Location type"
            value={form.locationType}
            options={LOCATION_OPTIONS}
            onChange={(e) => setForm((f) => ({ ...f, locationType: e.target.value as MeetingLocationType }))}
          />
          {form.locationType === 'zoom' ? (
            <Input
              label="Zoom meeting ID"
              value={form.zoomMeetingId}
              onChange={(e) => setForm((f) => ({ ...f, zoomMeetingId: e.target.value }))}
            />
          ) : (
            <Input
              label={form.locationType === 'physical' ? 'Address' : 'Meeting link'}
              value={form.locationDetail}
              onChange={(e) => setForm((f) => ({ ...f, locationDetail: e.target.value }))}
            />
          )}

          <Select
            label="Organizer"
            value={form.organizerUserId}
            placeholder="Choose organizer…"
            options={peopleOptions}
            onChange={(e) => setForm((f) => ({ ...f, organizerUserId: e.target.value }))}
          />

          <div className="nx-field">
            <label className="nx-field__label">Agenda</label>
            <textarea
              className="nx-textarea"
              placeholder="What this meeting will cover"
              value={form.agenda}
              onChange={(e) => setForm((f) => ({ ...f, agenda: e.target.value }))}
              rows={3}
            />
          </div>

          {people.length > 0 && (
            <div className="nx-field">
              <label className="nx-field__label">Invitees</label>
              <div className="nx-stack nx-stack--sm" style={{ maxHeight: 160, overflowY: 'auto' }}>
                {people.map((p) => (
                  <Checkbox
                    key={p.id}
                    label={p.name}
                    checked={form.inviteeUserIds.includes(p.id)}
                    onChange={() => toggleInvitee(p.id)}
                  />
                ))}
              </div>
            </div>
          )}

          <Input
            label="External attendees (optional)"
            placeholder="jane@partner.com, sam@partner.com"
            value={form.externalEmails}
            onChange={(e) => setForm((f) => ({ ...f, externalEmails: e.target.value }))}
          />

          <div className="nx-field">
            <label className="nx-field__label">Notes</label>
            <textarea
              className="nx-textarea"
              placeholder="Anything else worth recording"
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              rows={2}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <Button type="button" variant="ghost" disabled={saving} onClick={() => setDrawer(null)}>
              Cancel
            </Button>
            <Button type="button" disabled={saving} onClick={handleSave}>
              {drawer?.mode === 'edit' ? 'Save changes' : 'Schedule meeting'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
