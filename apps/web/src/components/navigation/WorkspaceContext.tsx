// Session 57 — the companies you belong to and any open invitations,
// loaded once for the signed-in shell and shared by the switcher, the
// invitation banner and the "All my companies" page.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Workspace, WorkspaceInvitation } from '@nexus/shared';
import { fetchWorkspaces, switchWorkspace } from '../../services/workspaceService';

interface WorkspaceContextValue {
  workspaces: Workspace[];
  invitations: WorkspaceInvitation[];
  current?: Workspace;
  loaded: boolean;
  reload: () => Promise<void>;
  /** Moves this session into another company, then reloads the app there
   * (everything on screen belongs to one company, so a clean load is the
   * honest way to change it). */
  switchTo: (orgId: string, path?: string) => Promise<void>;
}

const Ctx = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await fetchWorkspaces();
      setWorkspaces(r.workspaces);
      setInvitations(r.invitations);
    } catch {
      // The switcher is a convenience: if this fails the app still works
      // in the company the session is already in.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const switchTo = useCallback(async (orgId: string, path = '/work/my-tasks') => {
    await switchWorkspace(orgId);
    window.location.assign(path);
  }, []);

  return (
    <Ctx.Provider value={{ workspaces, invitations, current: workspaces.find((w) => w.isCurrent), loaded, reload, switchTo }}>
      {children}
    </Ctx.Provider>
  );
}

export function useWorkspaces(): WorkspaceContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorkspaces must be used inside <WorkspaceProvider>');
  return v;
}
