import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Badge, Button, Input, Select, LoadingState, ErrorState, EmptyState } from '../../components/ui';
import { fetchKnowledgeEntries } from '../../services/knowledgeService';
import type { KnowledgeEntry } from '@nexus/shared';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: KnowledgeEntry[] };

// PRD §8.6: "v1 behavior: Keep simple concatenation for the AI context
// injection. Add structured search/filter." — filtering here is
// client-side over the full (unarchived) set rather than a round trip
// per keystroke: §8.6's own v2 flag ("if the knowledge base grows beyond
// ~50 dense entries...") is the same threshold at which client-side
// search would also start to make sense to move server-side; below it,
// fetching once and filtering in memory is simpler and just as correct.
export function Browse() {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');

  function load() {
    setState({ status: 'loading' });
    fetchKnowledgeEntries()
      .then((entries) => setState({ status: 'ready', entries }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setState({ status: 'error', message });
      });
  }

  useEffect(load, []);

  const categories = useMemo(() => {
    if (state.status !== 'ready') return [];
    const set = new Set(state.entries.map((e) => e.category).filter((c): c is string => !!c));
    return Array.from(set).sort();
  }, [state]);

  const filtered = useMemo(() => {
    if (state.status !== 'ready') return [];
    const q = search.trim().toLowerCase();
    return state.entries.filter((e) => {
      if (category && e.category !== category) return false;
      if (!q) return true;
      return e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q);
    });
  }, [state, search, category]);

  return (
    <div className="nx-page nx-view-enter">
      <div className="nx-row nx-row--between">
        <h2>Knowledge Base</h2>
        <Link to="/knowledge/edit">
          <Button>New entry</Button>
        </Link>
      </div>

      {state.status === 'loading' && <LoadingState label="Loading knowledge base…" />}
      {state.status === 'error' && (
        <ErrorState title="Couldn't load knowledge base" description={state.message} onRetry={load} />
      )}

      {state.status === 'ready' && (
        <>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <Input
                placeholder="Search titles and content…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {categories.length > 0 && (
              <div style={{ width: 200 }}>
                <Select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="All categories"
                  options={categories.map((c) => ({ value: c, label: c }))}
                />
              </div>
            )}
          </div>

          {filtered.length === 0 && (
            <EmptyState
              title={state.entries.length === 0 ? 'No entries yet' : 'No matches'}
              description={
                state.entries.length === 0
                  ? 'Add the first entry — it becomes part of what the AI Analyst knows.'
                  : 'Try a different search term or clear the category filter.'
              }
              action={
                state.entries.length === 0 ? (
                  <Link to="/knowledge/edit"><Button>New entry</Button></Link>
                ) : undefined
              }
            />
          )}

          {filtered.length > 0 && (
            <div className="nx-stack nx-stack--sm">
              {filtered.map((entry) => (
                <Link key={entry.id} to={`/knowledge/edit/${entry.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <Card interactive style={{ padding: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                      <strong>{entry.title}</strong>
                      {entry.category && <Badge tone="neutral">{entry.category}</Badge>}
                    </div>
                    <p style={{ opacity: 0.75, marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.content}
                    </p>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
