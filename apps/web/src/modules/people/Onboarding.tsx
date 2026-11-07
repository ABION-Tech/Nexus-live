// PRD §7.2 04 PEOPLE → Onboarding. Two tabs:
//  - "Checklist": self-service by default (GET/PATCH your own progress
//    needs no grant, routes/onboarding.ts). Leaders/authorized users get
//    a "viewing" picker to check things off on a new hire's behalf —
//    same "leaders, or those authorized" requirement Leave's approve
//    queue expresses, just phrased as "who am I editing" instead of
//    "who am I deciding for".
//  - "Manage checklist" (leader-gated in the UI, same convention as
//    Leave's Team tab / ia.ts's own permissionGated sections — a UX
//    convenience, not the actual security boundary, which is
//    routes/onboarding.ts's `onboarding.create/update/delete` grants):
//    add, edit, and archive the org's adjustable step template.
import { useEffect, useMemo, useState } from 'react';
import { Card, Button, Badge, Checkbox, Input, Select, Tabs, LoadingState, ErrorState, EmptyState, useToast } from '../../components/ui';
import {
  archiveOnboardingStep,
  createOnboardingStep,
  fetchOnboardingChecklist,
  fetchOnboardingSteps,
  setOnboardingStepCompletion,
  updateOnboardingStep,
} from '../../services/onboardingService';
import { fetchPeople } from '../../services/peopleService';
import type { OnboardingChecklistItem, OnboardingStep, Person } from '@nexus/shared';
import type { CurrentUser } from '../../services/authService';
import { ApiError } from '../../services/apiClient';

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

// --- Checklist tab -----------------------------------------------------

function ChecklistTab({ user, isLeader }: { user: CurrentUser; isLeader: boolean }) {
  const { show } = useToast();
  const [people, setPeople] = useState<Person[]>([]);
  const [viewingUserId, setViewingUserId] = useState(user.id);
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: OnboardingChecklistItem[] }
  >({ status: 'loading' });
  const [togglingStepId, setTogglingStepId] = useState<string | null>(null);

  useEffect(() => {
    if (isLeader) fetchPeople().then(setPeople).catch(() => setPeople([]));
  }, [isLeader]);

  function load() {
    setState({ status: 'loading' });
    fetchOnboardingChecklist(viewingUserId === user.id ? undefined : viewingUserId)
      .then((items) => setState({ status: 'ready', items }))
      .catch((err: unknown) => setState({ status: 'error', message: errorMessage(err) }));
  }

  useEffect(load, [viewingUserId, user.id]);

  async function handleToggle(item: OnboardingChecklistItem) {
    setTogglingStepId(item.step.id);
    try {
      await setOnboardingStepCompletion(item.step.id, !item.completed, viewingUserId === user.id ? undefined : viewingUserId);
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setTogglingStepId(null);
    }
  }

  const progress = useMemo(() => {
    if (state.status !== 'ready' || state.items.length === 0) return null;
    const done = state.items.filter((i) => i.completed).length;
    return { done, total: state.items.length };
  }, [state]);

  const peopleOptions = useMemo(
    () => [{ value: user.id, label: 'Me' }, ...people.filter((p) => p.id !== user.id).map((p) => ({ value: p.id, label: p.name }))],
    [people, user.id]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {isLeader && (
        <Select
          label="Viewing checklist for"
          value={viewingUserId}
          options={peopleOptions}
          onChange={(e) => setViewingUserId(e.target.value)}
          style={{ maxWidth: 280 }}
        />
      )}

      {state.status === 'loading' && <LoadingState label="Loading checklist…" />}
      {state.status === 'error' && <ErrorState title="Couldn't load checklist" description={state.message} onRetry={load} />}

      {state.status === 'ready' && (
        <Card>
          {progress && (
            <div style={{ marginBottom: 12, fontSize: 14, opacity: 0.8 }}>
              {progress.done} of {progress.total} steps complete
            </div>
          )}
          {state.items.length === 0 && (
            <EmptyState
              title="No onboarding steps yet"
              description={isLeader ? 'Add steps in "Manage checklist" to get started.' : 'Nothing has been set up yet — check back soon.'}
            />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {state.items.map((item) => (
              <Checkbox
                key={item.step.id}
                label={item.step.title}
                checked={item.completed}
                disabled={togglingStepId !== null}
                onChange={() => handleToggle(item)}
              />
            ))}
          </div>
          {state.items.some((i) => i.step.description) && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {state.items
                .filter((i) => i.step.description)
                .map((i) => (
                  <p key={i.step.id} style={{ fontSize: 13, opacity: 0.7, margin: 0 }}>
                    <strong>{i.step.title}:</strong> {i.step.description}
                  </p>
                ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// --- Manage tab (leaders / authorized users) ----------------------------

interface StepFormState {
  title: string;
  description: string;
}

const EMPTY_STEP: StepFormState = { title: '', description: '' };

function ManageTab() {
  const { show } = useToast();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; steps: OnboardingStep[] }
  >({ status: 'loading' });
  const [form, setForm] = useState<StepFormState>(EMPTY_STEP);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  function load() {
    setState({ status: 'loading' });
    fetchOnboardingSteps(true)
      .then((steps) => setState({ status: 'ready', steps }))
      .catch((err: unknown) => setState({ status: 'error', message: errorMessage(err) }));
  }

  useEffect(load, []);

  async function handleAdd() {
    if (!form.title.trim()) {
      show('Title is required.', 'danger');
      return;
    }
    setSaving(true);
    try {
      await createOnboardingStep({ title: form.title.trim(), description: form.description || undefined });
      show('Step added.', 'success');
      setForm(EMPTY_STEP);
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function handleRename(step: OnboardingStep, title: string, description: string) {
    setSaving(true);
    try {
      await updateOnboardingStep(step.id, { title, description: description || undefined });
      show('Saved.', 'success');
      setEditingId(null);
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(step: OnboardingStep) {
    setSaving(true);
    try {
      if (step.isActive) {
        await archiveOnboardingStep(step.id);
        show('Step archived.', 'default');
      } else {
        await updateOnboardingStep(step.id, { isActive: true });
        show('Step restored.', 'success');
      }
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setSaving(false);
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading steps…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load steps" description={state.message} onRetry={load} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <h3 style={{ marginBottom: 12 }}>Add a step</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
          <Input label="Title" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          <Input
            label="Description (optional)"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <div>
            <Button size="sm" disabled={saving} onClick={handleAdd}>Add step</Button>
          </div>
        </div>
      </Card>

      <Card>
        <h3 style={{ marginBottom: 12 }}>Checklist template</h3>
        {state.steps.length === 0 && <EmptyState title="No steps yet" description="Add the first step above." />}
        <div className="nx-stack nx-stack--sm">
          {state.steps.map((step) =>
            editingId === step.id ? (
              <StepEditRow key={step.id} step={step} saving={saving} onCancel={() => setEditingId(null)} onSave={handleRename} />
            ) : (
              <div
                key={step.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: '10px 0',
                  borderBottom: '1px solid var(--nx-border, #eee)',
                  opacity: step.isActive ? 1 : 0.55,
                }}
              >
                <div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <strong>{step.title}</strong>
                    {!step.isActive && <Badge tone="neutral">Archived</Badge>}
                  </div>
                  {step.description && <p style={{ fontSize: 13, opacity: 0.7, marginTop: 2 }}>{step.description}</p>}
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditingId(step.id)}>Edit</Button>
                  <Button size="sm" variant={step.isActive ? 'danger' : 'secondary'} disabled={saving} onClick={() => handleToggleActive(step)}>
                    {step.isActive ? 'Archive' : 'Restore'}
                  </Button>
                </div>
              </div>
            )
          )}
        </div>
      </Card>
    </div>
  );
}

function StepEditRow({
  step,
  saving,
  onCancel,
  onSave,
}: {
  step: OnboardingStep;
  saving: boolean;
  onCancel: () => void;
  onSave: (step: OnboardingStep, title: string, description: string) => void;
}) {
  const [title, setTitle] = useState(step.title);
  const [description, setDescription] = useState(step.description ?? '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0', borderBottom: '1px solid var(--nx-border, #eee)' }}>
      <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="nx-row">
        <Button size="sm" disabled={saving} onClick={() => onSave(step, title, description)}>Save</Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// --- Page ---------------------------------------------------------------

export function Onboarding({ user }: { user: CurrentUser }) {
  const isLeader = user.role === 'leader';
  const [tab, setTab] = useState<'checklist' | 'manage'>('checklist');

  return (
    <div className="nx-dashboard-overview">
      <div className="nx-app-main__header" style={{ padding: 0, marginBottom: 16 }}>
        <h1>Onboarding</h1>
      </div>

      {isLeader && (
        <div style={{ marginBottom: 16 }}>
          <Tabs
            items={[
              { key: 'checklist', label: 'Checklist' },
              { key: 'manage', label: 'Manage checklist' },
            ]}
            active={tab}
            onChange={(k) => setTab(k as 'checklist' | 'manage')}
          />
        </div>
      )}

      {tab === 'checklist' && <ChecklistTab user={user} isLeader={isLeader} />}
      {tab === 'manage' && isLeader && <ManageTab />}
    </div>
  );
}
