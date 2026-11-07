import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Card, Button, Input, LoadingState, ErrorState, useToast } from '../../components/ui';
import {
  createKnowledgeEntry,
  fetchKnowledgeEntry,
  updateKnowledgeEntry,
  archiveKnowledgeEntry,
} from '../../services/knowledgeService';

type LoadState =
  | { status: 'new' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready' };

// PRD §7.2 06 KNOWLEDGE's second subsection: "Add / Edit Entry" — one
// page for both, distinguished by whether :id is present in the route
// (mirrors goals' /goals/:id being a drill-in added outside the fixed
// IA path list — see App.tsx's comment on that route). No :id → create;
// :id present → load that entry and PATCH instead of POST on save.
export function EditEntry() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { show } = useToast();
  const isEditing = Boolean(id);

  const [state, setState] = useState<LoadState>(isEditing ? { status: 'loading' } : { status: 'new' });
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function load() {
    if (!id) return;
    setState({ status: 'loading' });
    fetchKnowledgeEntry(id)
      .then((entry) => {
        setTitle(entry.title);
        setContent(entry.content);
        setCategory(entry.category ?? '');
        setState({ status: 'ready' });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setState({ status: 'error', message });
      });
  }

  useEffect(load, [id]);

  async function handleSave() {
    if (!title.trim()) {
      setFormError('Give the entry a title.');
      return;
    }
    if (!content.trim()) {
      setFormError('Content can\u2019t be empty.');
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      const input = { title: title.trim(), content: content.trim(), category: category.trim() || undefined };
      if (isEditing && id) {
        await updateKnowledgeEntry(id, input);
        show('Entry saved.', 'success');
      } else {
        await createKnowledgeEntry(input);
        show('Entry added.', 'success');
      }
      navigate('/knowledge');
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive() {
    if (!id) return;
    if (!confirm('Archive this entry? It will no longer show in Knowledge Base or the AI context.')) return;
    try {
      await archiveKnowledgeEntry(id);
      show('Entry archived.', 'success');
      navigate('/knowledge');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Archive failed.', 'danger');
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading entry…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load entry" description={state.message} onRetry={load} />;

  return (
    <div className="nx-page nx-page--narrow nx-view-enter" style={{ maxWidth: 640 }}>
      <div>
        <Link to="/knowledge" style={{ fontSize: 13 }}>← Knowledge Base</Link>
      </div>

      <h2>{isEditing ? 'Edit entry' : 'New entry'}</h2>

      <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input
          label="Title"
          placeholder="e.g. State partnership onboarding checklist"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <Input
          label="Category (optional)"
          placeholder="e.g. Onboarding, HR, Partnerships"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <div className="nx-field">
          <label className="nx-field__label" htmlFor="knowledge-content">Content</label>
          <textarea
            id="knowledge-content"
            className="nx-input"
            rows={10}
            placeholder="Everything in here becomes part of what the AI Analyst knows — write it the way you'd explain it to a new team member."
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </div>
        {formError && <span className="nx-field__error">{formError}</span>}

        <div className="nx-row nx-row--between">
          {isEditing ? (
            <Button variant="danger" size="sm" onClick={handleArchive} disabled={saving}>
              Archive
            </Button>
          ) : <span />}
          <div className="nx-row">
            <Button variant="ghost" onClick={() => navigate('/knowledge')} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {isEditing ? 'Save changes' : 'Add entry'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
