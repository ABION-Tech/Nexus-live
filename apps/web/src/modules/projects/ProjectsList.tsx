// ADMIN_BUILD_GUIDE.md §2: "List view — each project row has an expand
// affordance showing a trimmed inline task summary (title, assignee,
// status) for fast skimming across multiple projects without leaving
// the list." Same file shape as ActiveGoals.tsx, with the expand
// behavior ActiveGoals doesn't have (goals' list intentionally omits
// progress to avoid an N+1 — projects' list payload already includes
// tasks, so there's no such cost here; see projectService.ts's
// listProjectsWithTasks comment).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Button, Modal, Input, StatusBadge, LoadingState, ErrorState, EmptyState, useToast } from '../../components/ui';
import { fetchProjects, createProject } from '../../services/projectService';
import type { ProjectWithTasks } from '@nexus/shared';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; projects: ProjectWithTasks[] };

export function ProjectsList() {
  const { show } = useToast();
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function load() {
    setList({ status: 'loading' });
    fetchProjects('active')
      .then((projects) => setList({ status: 'ready', projects }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setList({ status: 'error', message });
      });
  }

  useEffect(load, []);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCreate() {
    if (!title.trim()) {
      setFormError('Give the project a title.');
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      await createProject(title.trim(), description.trim() || undefined);
      setModalOpen(false);
      setTitle('');
      setDescription('');
      show('Project created.', 'success');
      load();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Could not create the project.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="nx-page nx-view-enter">
      <div className="nx-row nx-row--between">
        <h2>Projects</h2>
        <Button onClick={() => setModalOpen(true)}>New project</Button>
      </div>

      {list.status === 'loading' && <LoadingState label="Loading projects…" />}
      {list.status === 'error' && <ErrorState title="Couldn't load projects" description={list.message} onRetry={load} />}
      {list.status === 'ready' && list.projects.length === 0 && (
        <EmptyState
          title="No active projects yet"
          description="A project gives an external collaborator or guest visibility into a whole slice of work, not just individual tasks."
          action={<Button onClick={() => setModalOpen(true)}>New project</Button>}
        />
      )}
      {list.status === 'ready' && list.projects.length > 0 && (
        <div className="nx-stack nx-stack--md">
          {list.projects.map((project) => {
            const isExpanded = expanded.has(project.id);
            return (
              <Card key={project.id} style={{ padding: 0 }}>
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 16, cursor: 'pointer' }}
                  onClick={() => toggleExpanded(project.id)}
                >
                  <div className="nx-row">
                    <span style={{ fontSize: 12, opacity: 0.6, width: 12, display: 'inline-block' }}>{isExpanded ? '▾' : '▸'}</span>
                    <div>
                      <strong>{project.title}</strong>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>
                        {project.doneTaskCount}/{project.taskCount} tasks done
                        {project.members.length > 0 ? ` · ${project.members.length} member${project.members.length === 1 ? '' : 's'}` : ''}
                      </div>
                    </div>
                  </div>
                  <Link to={`/work/projects/${project.id}`} onClick={(e) => e.stopPropagation()}>
                    <Button size="sm" variant="secondary">Open</Button>
                  </Link>
                </div>

                {isExpanded && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '8px 16px 16px' }}>
                    {project.tasks.length === 0 ? (
                      <p style={{ opacity: 0.7, fontSize: 13, margin: '8px 0' }}>No tasks yet.</p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                        {project.tasks.map((task) => (
                          <div key={task.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '4px 0' }}>
                            <span>{task.title}</span>
                            <StatusBadge status={task.status} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => (saving ? undefined : setModalOpen(false))} title="New project">
        <div className="nx-stack nx-stack--md">
          <Input
            label="Project title"
            placeholder="e.g. Lagos office fit-out"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            error={formError ?? undefined}
            autoFocus
          />
          <Input
            label="Description (optional)"
            placeholder="What is this project for?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setModalOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={handleCreate} disabled={saving}>{saving ? 'Creating…' : 'Create project'}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
