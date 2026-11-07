import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Card, Badge, Button, Input, Select, LoadingState, ErrorState, useToast } from '../../components/ui';
import {
  archiveMarketingContentItem,
  createMarketingContentItem,
  fetchMarketingContentItem,
  updateMarketingContentItem,
  updateMarketingStage,
} from '../../services/marketingService';
import { fetchPeople } from '../../services/peopleService';
import {
  MARKETING_STAGE_LABELS,
  type MarketingContentStatus,
  type MarketingContentWithStages,
  type MarketingStage,
  type Person,
  type Task,
  type TaskStatus,
} from '@nexus/shared';

type LoadState =
  | { status: 'new' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready' };

const STATUS_OPTIONS: { value: MarketingContentStatus; label: string }[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'posted', label: 'Posted' },
  { value: 'skipped', label: 'Skipped' },
];

const TASK_STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
];

const STAGE_ORDER: MarketingStage[] = ['script', 'production', 'smm'];

function taskStatusTone(status: TaskStatus): 'neutral' | 'info' | 'success' | 'danger' {
  if (status === 'done') return 'success';
  if (status === 'in_progress') return 'info';
  if (status === 'blocked') return 'danger';
  return 'neutral';
}

// One row per stage in the "new content" form — script/production/smm
// each get their own assignee + deadline before the item is even
// created, since the point of breaking content into stages is knowing
// who's doing what from the start (writer vs. shoot/cast/edit crew vs.
// the SMM who captions and uploads).
function StageField({
  stage,
  people,
  assignedToUserId,
  deadline,
  onAssigneeChange,
  onDeadlineChange,
}: {
  stage: MarketingStage;
  people: Person[];
  assignedToUserId: string;
  deadline: string;
  onAssigneeChange: (v: string) => void;
  onDeadlineChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
      <div style={{ flex: 1 }}>
        <Select
          label={MARKETING_STAGE_LABELS[stage]}
          value={assignedToUserId}
          onChange={(e) => onAssigneeChange(e.target.value)}
          placeholder="Unassigned"
          options={people.map((p) => ({ value: p.id, label: p.name }))}
        />
      </div>
      <div style={{ width: 170 }}>
        <Input type="date" value={deadline} onChange={(e) => onDeadlineChange(e.target.value)} />
      </div>
    </div>
  );
}

// Row shown once a content item exists — assignee/deadline can be
// changed inline, and status is its own control, since "mark this stage
// done" is the single most common edit and shouldn't require opening a
// separate form.
function StageRow({
  stage,
  task,
  people,
  onChange,
  saving,
}: {
  stage: MarketingStage;
  task: Task | undefined;
  people: Person[];
  onChange: (stage: MarketingStage, patch: { assignedToUserId?: string; deadline?: string; status?: TaskStatus }) => void;
  saving: boolean;
}) {
  return (
    <Card style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="nx-row nx-row--between">
        <strong>{MARKETING_STAGE_LABELS[stage]}</strong>
        {task && <Badge tone={taskStatusTone(task.status)}>{TASK_STATUS_OPTIONS.find((s) => s.value === task.status)?.label}</Badge>}
      </div>
      {!task ? (
        <p style={{ opacity: 0.6, fontSize: 13, margin: 0 }}>Stage task not found — it may have been archived directly.</p>
      ) : (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 160, flex: 1 }}>
            <Select
              label="Assigned to"
              value={task.assignedToUserId ?? ''}
              onChange={(e) => onChange(stage, { assignedToUserId: e.target.value })}
              placeholder="Unassigned"
              options={people.map((p) => ({ value: p.id, label: p.name }))}
              disabled={saving}
            />
          </div>
          <div style={{ width: 160 }}>
            <Input
              label="Deadline"
              type="date"
              value={task.deadline ? task.deadline.slice(0, 10) : ''}
              onChange={(e) => onChange(stage, { deadline: e.target.value })}
              disabled={saving}
            />
          </div>
          <div style={{ width: 150 }}>
            <Select
              label="Status"
              value={task.status}
              onChange={(e) => onChange(stage, { status: e.target.value as TaskStatus })}
              options={TASK_STATUS_OPTIONS}
              disabled={saving}
            />
          </div>
        </div>
      )}
    </Card>
  );
}

// PRD §7.2 09 COMMS & OPS → Marketing / §8.9. One page for both create
// (:id absent — no server round trip until Save, since the three stage
// tasks are created atomically with the content item) and edit (:id
// present — stage changes save immediately, same "each control is its
// own save" shape as EodReport's inline filing rather than a batched
// form, since reassigning one stage shouldn't risk clobbering another).
export function MarketingEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { show } = useToast();
  const isEditing = Boolean(id);

  const [state, setState] = useState<LoadState>(isEditing ? { status: 'loading' } : { status: 'new' });
  const [people, setPeople] = useState<Person[]>([]);
  const [item, setItem] = useState<MarketingContentWithStages | null>(null);

  // Create-form-only fields.
  const [contentType, setContentType] = useState('');
  const [platform, setPlatform] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [postLink, setPostLink] = useState('');
  const [stageAssignees, setStageAssignees] = useState<Record<MarketingStage, string>>({ script: '', production: '', smm: '' });
  const [stageDeadlines, setStageDeadlines] = useState<Record<MarketingStage, string>>({ script: '', production: '', smm: '' });

  const [saving, setSaving] = useState(false);
  const [savingStage, setSavingStage] = useState<MarketingStage | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  function load() {
    fetchPeople().then(setPeople).catch(() => undefined);
    if (!id) return;
    setState({ status: 'loading' });
    fetchMarketingContentItem(id)
      .then((data) => {
        setItem(data);
        setContentType(data.contentType ?? '');
        setPlatform(data.platform ?? '');
        setDueDate(data.dueDate ?? '');
        setPostLink(data.postLink ?? '');
        setState({ status: 'ready' });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setState({ status: 'error', message });
      });
  }

  useEffect(load, [id]);

  async function handleCreate() {
    setFormError(null);
    setSaving(true);
    try {
      const stageInput = (stage: MarketingStage) => ({
        assignedToUserId: stageAssignees[stage] || undefined,
        deadline: stageDeadlines[stage] || undefined,
      });
      const created = await createMarketingContentItem({
        contentType: contentType.trim() || undefined,
        platform: platform.trim() || undefined,
        dueDate: dueDate || undefined,
        postLink: postLink.trim() || undefined,
        script: stageInput('script'),
        production: stageInput('production'),
        smm: stageInput('smm'),
      });
      show('Content added — script, production, and SMM stages created.', 'success');
      navigate(`/comms-ops/marketing/${created.id}`);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTopLevelChange(patch: { status?: MarketingContentStatus; postLink?: string }) {
    if (!id) return;
    try {
      const updated = await updateMarketingContentItem(id, patch);
      setItem((prev) => (prev ? { ...prev, ...updated } : prev));
      show('Saved.', 'success');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Update failed.', 'danger');
    }
  }

  async function handleStageChange(
    stage: MarketingStage,
    patch: { assignedToUserId?: string; deadline?: string; status?: TaskStatus }
  ) {
    if (!id) return;
    setSavingStage(stage);
    try {
      const task = await updateMarketingStage(id, stage, patch);
      setItem((prev) => (prev ? { ...prev, stages: { ...prev.stages, [stage]: task } } : prev));
      show(`${MARKETING_STAGE_LABELS[stage]} updated.`, 'success');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Update failed.', 'danger');
    } finally {
      setSavingStage(null);
    }
  }

  async function handleArchive() {
    if (!id) return;
    if (!confirm('Archive this content item? Its stage tasks stay as-is; the calendar entry is removed from the list.')) return;
    try {
      await archiveMarketingContentItem(id);
      show('Content archived.', 'success');
      navigate('/comms-ops/marketing');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Archive failed.', 'danger');
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading content…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load content" description={state.message} onRetry={load} />;

  return (
    <div className="nx-page nx-page--narrow nx-view-enter" style={{ maxWidth: 680 }}>
      <div>
        <Link to="/comms-ops/marketing" style={{ fontSize: 13 }}>← Marketing</Link>
      </div>

      <h2>{isEditing ? 'Content details' : 'New content'}</h2>

      <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input
          label="Content type"
          placeholder="e.g. Instagram post, blog article, newsletter"
          value={contentType}
          onChange={(e) => setContentType(e.target.value)}
          disabled={isEditing}
          autoFocus={!isEditing}
        />
        <Input
          label="Platform"
          placeholder="e.g. Instagram, LinkedIn, Website"
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          disabled={isEditing}
        />
        <Input
          label="Due date"
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          disabled={isEditing}
        />
        {isEditing && item && (
          <Select
            label="Overall status"
            value={item.status}
            onChange={(e) => handleTopLevelChange({ status: e.target.value as MarketingContentStatus })}
            options={STATUS_OPTIONS}
          />
        )}
        <Input
          label="Post link (optional)"
          placeholder="https://…"
          value={isEditing ? (item?.postLink ?? '') : postLink}
          onChange={(e) =>
            isEditing ? handleTopLevelChange({ postLink: e.target.value || undefined }) : setPostLink(e.target.value)
          }
        />
        {isEditing && item?.postLink && (
          <a href={item.postLink} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>View post →</a>
        )}
        {formError && <span className="nx-field__error">{formError}</span>}
      </Card>

      <div className="nx-stack nx-stack--sm">
        <h3 style={{ marginBottom: 0 }}>Stages</h3>
        <p style={{ opacity: 0.7, fontSize: 13, marginTop: 0 }}>
          Every piece of content is broken into three stages, each assignable to a different person.
        </p>

        {!isEditing &&
          STAGE_ORDER.map((stage) => (
            <StageField
              key={stage}
              stage={stage}
              people={people}
              assignedToUserId={stageAssignees[stage]}
              deadline={stageDeadlines[stage]}
              onAssigneeChange={(v) => setStageAssignees((prev) => ({ ...prev, [stage]: v }))}
              onDeadlineChange={(v) => setStageDeadlines((prev) => ({ ...prev, [stage]: v }))}
            />
          ))}

        {isEditing &&
          item &&
          STAGE_ORDER.map((stage) => (
            <StageRow
              key={stage}
              stage={stage}
              task={item.stages[stage]}
              people={people}
              onChange={handleStageChange}
              saving={savingStage === stage}
            />
          ))}
      </div>

      <div className="nx-row nx-row--between">
        {isEditing ? (
          <Button variant="danger" size="sm" onClick={handleArchive}>
            Archive
          </Button>
        ) : <span />}
        <div className="nx-row">
          <Button variant="ghost" onClick={() => navigate('/comms-ops/marketing')}>
            {isEditing ? 'Done' : 'Cancel'}
          </Button>
          {!isEditing && (
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? 'Creating…' : 'Add content'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
