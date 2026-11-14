// Session 57 — a company has invited you. Nobody joins a company without
// saying yes, so this waits at the top of the app until you choose.
import { useState } from 'react';
import type { WorkspaceInvitation } from '@nexus/shared';
import { useWorkspaces } from './WorkspaceContext';
import { acceptInvitation, declineInvitation, ROLE_LABEL } from '../../services/workspaceService';
import { Button, useToast } from '../ui';

export function InvitationBanner({ readOnly = false }: { readOnly?: boolean }) {
  const { invitations, reload, switchTo } = useWorkspaces();
  const { show } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [joined, setJoined] = useState<{ orgId: string; name: string } | null>(null);

  if (readOnly || (invitations.length === 0 && !joined)) return null;

  async function join(inv: WorkspaceInvitation) {
    setBusy(inv.id);
    try {
      await acceptInvitation(inv.id);
      setJoined({ orgId: inv.orgId, name: inv.orgName });
      await reload();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't join. Try again.", 'danger');
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function decline(inv: WorkspaceInvitation) {
    setBusy(inv.id);
    try {
      await declineInvitation(inv.id);
      show(`Declined ${inv.orgName}'s invitation.`, 'default');
      await reload();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't decline. Try again.", 'danger');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="nx-invites" role="region" aria-label="Invitations">
      {joined && (
        <div className="nx-invite nx-invite--done">
          <div className="nx-invite__text">
            <b>You've joined {joined.name}.</b>
            <span>It's in your company switcher, and its tasks now show in All my companies.</span>
          </div>
          <div className="nx-invite__actions">
            <Button onClick={() => switchTo(joined.orgId)}>Open {joined.name}</Button>
            <Button variant="ghost" onClick={() => setJoined(null)}>Stay here</Button>
          </div>
        </div>
      )}
      {invitations.map((inv) => (
        <div key={inv.id} className="nx-invite">
          <div className="nx-invite__text">
            <b>
              {inv.invitedByName ? `${inv.invitedByName} invited you` : "You're invited"} to join {inv.orgName}
            </b>
            <span>
              as {ROLE_LABEL[inv.role]?.toLowerCase() ?? inv.role}. Your other companies won't see anything from {inv.orgName}, and it won't see
              theirs.
            </span>
          </div>
          <div className="nx-invite__actions">
            <Button onClick={() => join(inv)} disabled={busy !== null}>
              {busy === inv.id ? 'Joining…' : 'Join'}
            </Button>
            <Button variant="secondary" onClick={() => decline(inv)} disabled={busy !== null}>
              Decline
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
