// PRD §10.5 / §8.2 Calendar — /work/calendar (modules/work, matching the
// rest of Work's subsections — not a standalone `pages/` tree). Built
// from the same primitives Integrations.tsx uses (Card/Button/Input/
// Select/Modal + useToast for action errors) so it inherits the app's
// dark ops-console palette by construction instead of shipping its own
// (bare-Tailwind, light-mode) styles.
//
// Three states:
//   no connections               → empty state, "Connect Google Calendar" CTA
//   connected, no subscriptions  → sidebar + guide user to add a calendar
//   subscriptions exist          → full view: sidebar + 7-day agenda
//
// Modals (tracked by `modal` discriminated union):
//   'pick-calendar'  → after clicking "Add calendar" on a connection
//   'create-event'   → new event form
//   'edit-event'     → edit/delete an existing event
import { useState, useEffect, useCallback, type FormEvent, type ReactNode } from 'react';
import { Button, Input, Select, Checkbox, Modal, EmptyState, LoadingState, useToast } from '../../components/ui';
import type {
  CalendarConnection,
  CalendarSubscription,
  GoogleCalendarListEntry,
  CalendarEvent,
  CalendarEventInput,
} from '@nexus/shared';
import {
  startCalendarOAuth,
  listConnections,
  listAvailableCalendars,
  disconnectConnection,
  listSubscriptions,
  createSubscription,
  removeSubscription,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from '../../services/calendarService';

// ── Helpers ──────────────────────────────────────────────────────────────

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // Sunday
  return d;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function formatDay(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTime(isoString?: string): string {
  if (!isoString) return '';
  return new Date(isoString).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatDateValue(date: Date): string {
  return date.toISOString().slice(0, 10); // yyyy-mm-dd
}

function formatDateTimeValue(date: Date): string {
  // <input type="datetime-local"> expects "yyyy-MM-ddTHH:mm"
  return date.toISOString().slice(0, 16);
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function eventStartDate(ev: CalendarEvent): Date {
  return new Date(ev.startAt ?? ev.startDate ?? '');
}

// Palette for subscription colour dots — cycles through 8 accent-adjacent
// hues that read against --surface / --surface-raised (dark theme, so no
// pastel Tailwind swatches).
const SUB_COLORS = ['#5b52f0', '#00d4a0', '#f5a623', '#ef4444', '#a78bfa', '#22d3ee', '#fb923c', '#a3e635'];

function subColor(index: number): string {
  return SUB_COLORS[index % SUB_COLORS.length] ?? '#5b52f0';
}

// ── Modal types ──────────────────────────────────────────────────────────

type PickCalendarModal = {
  kind: 'pick-calendar';
  connection: CalendarConnection;
  calendars: GoogleCalendarListEntry[];
  loading: boolean;
};

type CreateEventModal = { kind: 'create-event'; defaultDate?: Date };
type EditEventModal = { kind: 'edit-event'; event: CalendarEvent };
type ModalState = PickCalendarModal | CreateEventModal | EditEventModal | null;

// ── Main component ──────────────────────────────────────────────────────

export function Calendar() {
  const { show } = useToast();
  const [connections, setConnections] = useState<CalendarConnection[]>([]);
  const [subscriptions, setSubscriptions] = useState<CalendarSubscription[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [modal, setModal] = useState<ModalState>(null);
  const [loading, setLoading] = useState(true);

  // ── Data loading ─────────────────────────────────────────────────────

  const loadConnections = useCallback(async () => {
    try {
      setConnections(await listConnections());
    } catch {
      show('Could not load calendar connections.', 'danger');
    }
  }, [show]);

  const loadSubscriptions = useCallback(async () => {
    try {
      setSubscriptions(await listSubscriptions());
    } catch {
      show('Could not load calendar subscriptions.', 'danger');
    }
  }, [show]);

  const loadEvents = useCallback(
    async (from: Date) => {
      const to = addDays(from, 7);
      try {
        setEvents(await listEvents(from, to));
      } catch {
        show('Could not load events.', 'danger');
      }
    },
    [show],
  );

  useEffect(() => {
    Promise.all([loadConnections(), loadSubscriptions()]).finally(() => setLoading(false));
    // Only ever needed on mount — loadConnections/loadSubscriptions are
    // stable (useCallback) and re-running this on every render would
    // refetch on each keystroke elsewhere in the tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (subscriptions.length > 0) loadEvents(weekStart);
    else setEvents([]);
  }, [subscriptions, weekStart, loadEvents]);

  // ── Actions ──────────────────────────────────────────────────────────

  async function handleDisconnect(connection: CalendarConnection) {
    if (!window.confirm(`Disconnect ${connection.googleEmail}? This will stop syncing all calendars linked to this account.`)) return;
    try {
      await disconnectConnection(connection.id);
      setSubscriptions((prev) => prev.filter((s) => s.connectionId !== connection.id));
      setConnections((prev) => prev.filter((c) => c.id !== connection.id));
    } catch {
      show('Could not disconnect. Please try again.', 'danger');
    }
  }

  async function handleOpenCalendarPicker(connection: CalendarConnection) {
    const m: PickCalendarModal = { kind: 'pick-calendar', connection, calendars: [], loading: true };
    setModal(m);
    try {
      const calendars = await listAvailableCalendars(connection.id);
      setModal({ ...m, calendars, loading: false });
    } catch {
      setModal(null);
      show('Could not fetch your Google calendars. Try again.', 'danger');
    }
  }

  async function handleAddSubscription(connection: CalendarConnection, cal: GoogleCalendarListEntry) {
    try {
      const sub = await createSubscription(connection.id, cal.id, cal.summary);
      setSubscriptions((prev) => [...prev, sub]);
      setModal(null);
    } catch {
      show('Could not add that calendar. Please try again.', 'danger');
    }
  }

  async function handleRemoveSubscription(sub: CalendarSubscription) {
    if (!window.confirm(`Stop syncing "${sub.calendarName}"?`)) return;
    try {
      await removeSubscription(sub.id);
      setSubscriptions((prev) => prev.filter((s) => s.id !== sub.id));
    } catch {
      show('Could not remove that calendar. Please try again.', 'danger');
    }
  }

  async function handleCreateEvent(input: CalendarEventInput & { subscriptionId: string }) {
    try {
      const ev = await createEvent(input.subscriptionId, input);
      setEvents((prev) => [...prev, ev]);
      setModal(null);
      show('Event created.', 'success');
    } catch {
      show('Could not create event. Please try again.', 'danger');
    }
  }

  async function handleUpdateEvent(eventId: string, input: Partial<CalendarEventInput>) {
    try {
      const ev = await updateEvent(eventId, input);
      setEvents((prev) => prev.map((e) => (e.id === eventId ? ev : e)));
      setModal(null);
      show('Event updated.', 'success');
    } catch {
      show('Could not update event. Please try again.', 'danger');
    }
  }

  async function handleDeleteEvent(eventId: string) {
    if (!window.confirm('Delete this event? It will also be deleted from Google Calendar.')) return;
    try {
      await deleteEvent(eventId);
      setEvents((prev) => prev.filter((e) => e.id !== eventId));
      setModal(null);
      show('Event deleted.', 'success');
    } catch {
      show('Could not delete event. Please try again.', 'danger');
    }
  }

  // ── Render ───────────────────────────────────────────────────────────

  if (loading) return <LoadingState label="Loading your calendar…" />;

  if (connections.length === 0) {
    return (
      <EmptyState
        title="Connect Google Calendar"
        description="Sync your Google calendars into NEXUS to see events alongside your tasks and goals — and create events directly from here."
        action={
          <Button onClick={startCalendarOAuth}>
            <GoogleIcon /> Connect Google Calendar
          </Button>
        }
      />
    );
  }

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const subIndexMap = new Map(subscriptions.map((s, i) => [s.id, i]));

  return (
    <div className="nx-cal">
      {/* ── Sidebar ── */}
      <aside className="nx-cal__sidebar">
        <div className="nx-cal__sidebar-head">
          <Button variant="secondary" size="sm" onClick={startCalendarOAuth} className="nx-cal__connect-btn">
            <GoogleIcon /> Connect account
          </Button>
        </div>

        <div className="nx-cal__sidebar-body">
          {connections.map((conn) => {
            const connSubs = subscriptions.filter((s) => s.connectionId === conn.id);
            return (
              <div key={conn.id} className="nx-cal__account">
                <div className="nx-cal__account-head">
                  <span className="nx-cal__account-email">{conn.googleEmail}</span>
                  <button
                    onClick={() => handleDisconnect(conn)}
                    className="nx-cal__icon-btn"
                    title="Disconnect account"
                    aria-label="Disconnect account"
                  >
                    ✕
                  </button>
                </div>

                {connSubs.map((sub) => (
                  <div key={sub.id} className="nx-cal__sub">
                    <span className="nx-cal__sub-dot" style={{ backgroundColor: subColor(subIndexMap.get(sub.id) ?? 0) }} />
                    <span className="nx-cal__sub-name">{sub.calendarName}</span>
                    <button
                      onClick={() => handleRemoveSubscription(sub)}
                      className="nx-cal__icon-btn nx-cal__icon-btn--fade"
                      title="Remove calendar"
                      aria-label="Remove calendar"
                    >
                      ✕
                    </button>
                  </div>
                ))}

                <button onClick={() => handleOpenCalendarPicker(conn)} className="nx-cal__add-calendar">
                  <span className="nx-cal__add-icon">+</span> Add calendar
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      {/* ── Main area ── */}
      <main className="nx-cal__main">
        <header className="nx-cal__header">
          <button onClick={() => setWeekStart((prev) => addDays(prev, -7))} className="nx-cal__nav-btn" aria-label="Previous week">
            ‹
          </button>
          <button onClick={() => setWeekStart((prev) => addDays(prev, 7))} className="nx-cal__nav-btn" aria-label="Next week">
            ›
          </button>
          <h2 className="nx-cal__title">{weekStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</h2>
          <button onClick={() => setWeekStart(startOfWeek(new Date()))} className="nx-cal__today-btn">
            Today
          </button>
          <div className="nx-cal__spacer" />
          {subscriptions.length > 0 && <Button size="sm" onClick={() => setModal({ kind: 'create-event' })}>+ New event</Button>}
        </header>

        {subscriptions.length === 0 ? (
          <EmptyState
            title="No calendars synced yet"
            description='Click "+ Add calendar" under a connected account in the sidebar to pick which Google calendars to sync in.'
          />
        ) : (
          <div className="nx-cal__agenda">
            {weekDays.map((day) => {
              const dayEvents = events.filter((ev) => {
                const start = eventStartDate(ev);
                return !isNaN(start.getTime()) && isSameDay(start, day);
              });
              const isToday = isSameDay(day, new Date());

              return (
                <div key={day.toISOString()} className="nx-cal__day">
                  <div className={`nx-cal__day-head ${isToday ? 'nx-cal__day-head--today' : ''}`}>
                    <span className={`nx-cal__day-label ${isToday ? 'nx-cal__day-label--today' : ''}`}>{formatDay(day)}</span>
                    {dayEvents.length === 0 && <span className="nx-cal__day-empty">No events</span>}
                  </div>

                  <div className="nx-cal__day-events">
                    {dayEvents
                      .sort((a, b) => eventStartDate(a).getTime() - eventStartDate(b).getTime())
                      .map((ev) => {
                        const colorIndex = subIndexMap.get(ev.subscriptionId) ?? 0;
                        return (
                          <button key={ev.id} onClick={() => setModal({ kind: 'edit-event', event: ev })} className="nx-cal__event">
                            <span className="nx-cal__event-dot" style={{ backgroundColor: subColor(colorIndex) }} />
                            <div className="nx-cal__event-body">
                              <div className="nx-cal__event-title-row">
                                <span className="nx-cal__event-title">{ev.title}</span>
                                {ev.status === 'tentative' && <span className="nx-cal__event-tentative">tentative</span>}
                              </div>
                              <div className="nx-cal__event-meta">
                                {ev.allDay ? <span>All day</span> : <span>{formatTime(ev.startAt)} – {formatTime(ev.endAt)}</span>}
                                {ev.location && <span className="nx-cal__event-meta-trunc">· {ev.location}</span>}
                                <span className="nx-cal__event-meta-dim">· {ev.calendarName}</span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* ── Modals ── */}
      {modal?.kind === 'pick-calendar' && (
        <CalendarPickerModal modal={modal} subscriptions={subscriptions} onAdd={handleAddSubscription} onClose={() => setModal(null)} />
      )}

      {modal?.kind === 'create-event' && (
        <EventModal mode="create" subscriptions={subscriptions} defaultDate={modal.defaultDate} onSave={handleCreateEvent} onClose={() => setModal(null)} />
      )}

      {modal?.kind === 'edit-event' && (
        <EventModal
          mode="edit"
          event={modal.event}
          subscriptions={subscriptions}
          onSave={(input) => handleUpdateEvent(modal.event.id, input)}
          onDelete={() => handleDeleteEvent(modal.event.id)}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ── Calendar picker modal ───────────────────────────────────────────────

function CalendarPickerModal({
  modal,
  subscriptions,
  onAdd,
  onClose,
}: {
  modal: PickCalendarModal;
  subscriptions: CalendarSubscription[];
  onAdd: (connection: CalendarConnection, cal: GoogleCalendarListEntry) => void;
  onClose: () => void;
}) {
  const alreadySynced = new Set(subscriptions.filter((s) => s.connectionId === modal.connection.id).map((s) => s.googleCalendarId));

  return (
    <Modal open onClose={onClose} title="Add calendar">
      <p className="nx-cal__modal-subtitle">{modal.connection.googleEmail}</p>

      <div className="nx-cal__picker-list">
        {modal.loading ? (
          <p className="nx-cal__picker-empty">Loading your calendars…</p>
        ) : modal.calendars.length === 0 ? (
          <p className="nx-cal__picker-empty">No calendars found on this account.</p>
        ) : (
          modal.calendars.map((cal) => {
            const alreadyAdded = alreadySynced.has(cal.id);
            return (
              <div key={cal.id} className="nx-cal__picker-row">
                <div>
                  <div className="nx-cal__picker-row-title">
                    {cal.summary}
                    {cal.primary && <span className="nx-cal__picker-row-tag"> (primary)</span>}
                  </div>
                  <div className="nx-cal__picker-row-role">{cal.accessRole}</div>
                </div>
                {alreadyAdded ? (
                  <span className="nx-cal__picker-synced">Synced</span>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => onAdd(modal.connection, cal)}>
                    Add
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="nx-cal__modal-footer nx-cal__modal-footer--end">
        <Button variant="ghost" size="sm" onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

// ── Event modal (create + edit) ─────────────────────────────────────────

type EventModalProps =
  | {
      mode: 'create';
      subscriptions: CalendarSubscription[];
      defaultDate?: Date;
      onSave: (input: CalendarEventInput & { subscriptionId: string }) => void;
      onClose: () => void;
    }
  | {
      mode: 'edit';
      event: CalendarEvent;
      subscriptions: CalendarSubscription[];
      onSave: (input: Partial<CalendarEventInput>) => void;
      onDelete: () => void;
      onClose: () => void;
    };

function EventModal(props: EventModalProps) {
  const { mode, subscriptions, onClose } = props;
  const existing = mode === 'edit' ? props.event : undefined;

  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [location, setLocation] = useState(existing?.location ?? '');
  const [allDay, setAllDay] = useState(existing?.allDay ?? false);
  const [startAt, setStartAt] = useState(
    existing?.startAt
      ? formatDateTimeValue(new Date(existing.startAt))
      : formatDateTimeValue(props.mode === 'create' && props.defaultDate ? props.defaultDate : new Date()),
  );
  const [endAt, setEndAt] = useState(existing?.endAt ? formatDateTimeValue(new Date(existing.endAt)) : formatDateTimeValue(new Date()));
  const [startDate, setStartDate] = useState(existing?.startDate ?? formatDateValue(new Date()));
  const [endDate, setEndDate] = useState(existing?.endDate ?? formatDateValue(new Date()));
  const [subscriptionId, setSubscriptionId] = useState(existing?.subscriptionId ?? subscriptions[0]?.id ?? '');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      const base: CalendarEventInput = {
        title: title.trim(),
        description: description.trim() || undefined,
        location: location.trim() || undefined,
        allDay,
        ...(allDay ? { startDate, endDate } : { startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString() }),
      };
      if (mode === 'create') {
        await props.onSave({ ...base, subscriptionId });
      } else {
        await props.onSave(base);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={mode === 'create' ? 'New event' : 'Edit event'}>
      <form onSubmit={handleSubmit} className="nx-cal__event-form">
        <Input autoFocus placeholder="Event title" value={title} onChange={(e) => setTitle(e.target.value)} required />

        <Checkbox label="All day" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />

        {allDay ? (
          <div className="nx-cal__form-grid">
            <Input type="date" label="Start date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            <Input type="date" label="End date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        ) : (
          <div className="nx-cal__form-grid">
            <Input type="datetime-local" label="Start" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
            <Input type="datetime-local" label="End" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
          </div>
        )}

        <Input placeholder="Add location" label="Location" value={location} onChange={(e) => setLocation(e.target.value)} />

        <div className="nx-field">
          <label className="nx-field__label">Description</label>
          <textarea
            className="nx-textarea"
            placeholder="Add description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>

        {mode === 'create' && subscriptions.length > 1 && (
          <Select
            label="Calendar"
            value={subscriptionId}
            onChange={(e) => setSubscriptionId(e.target.value)}
            options={subscriptions.map((s) => ({ value: s.id, label: `${s.calendarName} · ${s.connectionEmail}` }))}
          />
        )}

        {mode === 'edit' && existing && (
          <div className="nx-cal__event-provenance">
            {existing.createdByNexus ? 'Created in NEXUS' : 'Synced from Google Calendar'}
            {existing.htmlLink && (
              <>
                {' '}
                ·{' '}
                <a href={existing.htmlLink} target="_blank" rel="noreferrer">
                  View in Google Calendar
                </a>
              </>
            )}
          </div>
        )}

        <div className="nx-cal__modal-footer">
          {mode === 'edit' && (
            <Button type="button" variant="ghost" size="sm" onClick={props.onDelete} className="nx-cal__delete-btn">
              Delete event
            </Button>
          )}
          <div className="nx-cal__spacer" />
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving || !title.trim()}>
            {saving ? 'Saving…' : mode === 'create' ? 'Create' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────

function GoogleIcon(): ReactNode {
  // Minimal Google "G" mark — white fill throughout since it only ever
  // sits on --surface-raised (secondary button) here, never on a white
  // background like the original light-mode version assumed.
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}
