// ADMIN_BUILD_GUIDE.md §2: "Full drill-in (ProjectDetail, mirroring
// GoalDetail's actual route pattern) — reached from the expanded row or
// a task title. Full task list, add task, reassign, edit status —
// everything that doesn't fit in a scannable row." Task
// reassign/status-edit reuses the existing task drawer/update flow
// (Work's own TaskCard interaction) rather than duplicating it here —
// this page focuses on the two things unique to a project: the task
// list in context, and membership.
//
// "Guest visibility is this same view, scoped" (§2) — a guest hitting
// this exact route sees exactly what's rendered here; the scoping
// happens server-side (routes/projects.ts's membership fallback), not
// by this component rendering differently for a guest. The only
// guest-relevant UI difference is that the member-management controls
// below are conditionally rendered for a caller who can actually use
// them — a guest without projects.update simply won't see an "Add
// member" button that would 403 if clicked.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Card, Button, StatusBadge, Badge, Avatar, Input, LoadingState, ErrorState, useToast } from '../../components/ui';
import {
  fetchProject,
  archiveProject,
  restoreProject,
  addProjectMember,
  removeProjectMember,
} from '../../services/projectService';
import type { CurrentUser } from '../../services/authService';
import type { ProjectWithTasks } from '@nexus/shared';

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; project: ProjectWithTasks };

export function ProjectDetail({ user }: { user: CurrentUser }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { show } = useToast();
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const [addingMember, setAddingMember] = useState(false);
  const [memberEmail, setMemberEmail] = useState('');
  const [memberError, setMemberError] = useState<string | null>(null);

  function load() {
    if (!id) return;
    setState({ status: 'loading' });
    fetchProject(id)
      .then((project) => setState({ status: 'ready', project }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setState({ status: 'error', message });
      });
  }

  useEffect(load, [id]);

  async function handleArchive() {
    if (!id) return;
    if (!confirm('Archive this project? Its tasks stay as they are — only the project is archived.')) return;
    try {
      await archiveProject(id);
      show('Project archived.', 'success');
      navigate('/work/projects');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Archive failed.', 'danger');
    }
  }

  async function handleRestore() {
    if (!id) return;
    try {
      await restoreProject(id);
      show('Project restored.', 'success');
      load();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Restore failed.', 'danger');
    }
  }

  async function handleAddMember() {
    if (!id || !memberEmail.trim()) {
      setMemberError('Enter an email address.');
      return;
    }
    setMemberError(null);
    setAddingMember(true);
    try {
      await addProjectMember(id, memberEmail.trim());
      setMemberEmail('');
      show('Member added.', 'success');
      load();
    } catch (err: unknown) {
      setMemberError(err instanceof Error ? err.message : 'Could not add that member.');
    } finally {
      setAddingMember(false);
    }
  }

  async function handleRemoveMember(userId: string) {
    if (!id) return;
    try {
      await removeProjectMember(id, userId);
      show('Member removed.', 'success');
      load();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Could not remove that member.', 'danger');
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading project…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load project" description={state.message} onRetry={load} />;

  const { project } = state;
  // Leader-only, same "own admin action" gating shape TeamRoles.tsx's
  // canManage already uses — no separate 'projects' permission check
  // client-side; the server enforces this for real on every write, this
  // is just hiding controls a caller couldn't use anyway.
  const canManage = user.role === 'leader';

  return (
    <div className="nx-page nx-page--narrow nx-view-enter" style={{ maxWidth: 760 }}>
      <div>
        <Link to="/work/projects" style={{ fontSize: 13 }}>← Projects</Link>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ marginBottom: 4 }}>{project.title}</h2>
          {project.description && <p style={{ opacity: 0.75, margin: '4px 0' }}>{project.description}</p>}
          <Badge tone={project.status === 'archived' ? 'neutral' : 'info'}>{project.status}</Badge>
        </div>
        {canManage && (
          <div className="nx-row">
            {project.status === 'active' ? (
              <Button variant="danger" size="sm" onClick={handleArchive}>Archive</Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={handleRestore}>Restore</Button>
            )}
          </div>
        )}
      </div>

      <Card style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Tasks</span>
          <span>{project.doneTaskCount}/{project.taskCount} done</span>
        </div>
      </Card>

      <div>
        <h3 style={{ marginBottom: 8 }}>Tasks ({project.taskCount})</h3>
        {project.tasks.length === 0 ? (
          <p style={{ opacity: 0.7 }}>No tasks in this project yet.</p>
        ) : (
          <div className="nx-stack nx-stack--sm">
            {project.tasks.map((task) => (
              <Card key={task.id} style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{task.title}</span>
                <StatusBadge status={task.status} />
              </Card>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 style={{ marginBottom: 8 }}>
          Members ({project.members.length})
        </h3>
        {/* ADMIN_BUILD_GUIDE.md §2: "the full container model... matches
            how an actual external collaborator works: 'you're on this
            project,' not 'here are 6 tasks, hope someone remembers to
            loop you in on the 7th.'" This list is that visibility —
            every member sees who else is on the project, guest or not,
            regardless of whether they can manage membership themselves. */}
        {project.members.length === 0 ? (
          <p style={{ opacity: 0.7 }}>No members added yet.</p>
        ) : (
          <div className="nx-stack nx-stack--sm">
            {project.members.map((member) => (
              <Card key={member.userId} style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="nx-row">
                  <Avatar name={member.name} size="sm" />
                  <div>
                    <div>{member.name}</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>{member.email}</div>
                  </div>
                </div>
                {canManage && (
                  <Button variant="ghost" size="sm" onClick={() => handleRemoveMember(member.userId)}>
                    Remove
                  </Button>
                )}
              </Card>
            ))}
          </div>
        )}

        {canManage && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <div style={{ flex: 1 }}>
              <Input
                placeholder="Email address"
                value={memberEmail}
                onChange={(e) => setMemberEmail(e.target.value)}
                error={memberError ?? undefined}
              />
            </div>
            <Button onClick={handleAddMember} disabled={addingMember}>
              {addingMember ? 'Adding…' : 'Add member'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
