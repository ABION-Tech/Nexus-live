import { useState } from 'react';
import { Badge, Button } from '../ui';
import { useToast } from '../ui';
import { endImpersonation, setImpersonationMode } from '../../services/impersonationService';
import type { CurrentUser, ImpersonationInfo } from '../../services/authService';

// Session 11 follow-up (ADMIN_BUILD_GUIDE.md §5) — the backend has
// shipped a fully audited start/end/mode-change impersonation feature
// since Session 11 (impersonationService.ts, routes/admin/impersonation.ts)
// with nothing on the frontend to show for it: no banner telling the
// actor (or anyone glancing at their screen) that this browser is
// currently signed in as someone else, and no exit control other than
// hitting the API by hand. This component is that banner. It only ever
// renders when GET /session's `impersonatedBy` is present (see
// auth.ts's own note on why that field exists at all) — a normal
// session renders nothing here.
//
// Deliberately does not add a "Start impersonation" trigger anywhere
// (e.g. SuperUsers.tsx) — that's a separate, larger surface (target
// picker, reason capture, mode choice) and SuperUsers.tsx is
// documented as a deliberately read-only investigation view. This
// closes the "no way to see or exit an impersonation in progress" gap
// specifically.
export function ImpersonationBanner({
  info,
  onEnded,
}: {
  info: ImpersonationInfo;
  onEnded: () => void;
}) {
  const { show } = useToast();
  const [ending, setEnding] = useState(false);
  const [changingMode, setChangingMode] = useState(false);

  function handleExit() {
    setEnding(true);
    endImpersonation()
      .then(() => {
        // Cookie is cleared server-side by /end — the actor's original
        // session was never revoked (impersonationService.ts's own
        // doc comment), but this browser has no session at all until
        // they sign back in. onEnded re-runs the app's session check,
        // same as a real logout, which will land them on LoginPage.
        onEnded();
      })
      .catch((err: unknown) => {
        setEnding(false);
        show(err instanceof Error ? err.message : "Couldn't end impersonation.", 'danger');
      });
  }

  function handleModeToggle() {
    const nextMode = info.mode === 'write' ? 'read_only' : 'write';
    setChangingMode(true);
    setImpersonationMode(nextMode)
      .then(() => {
        setChangingMode(false);
        onEnded(); // re-fetch /session so the banner reflects the new mode
      })
      .catch((err: unknown) => {
        setChangingMode(false);
        show(err instanceof Error ? err.message : "Couldn't change mode.", 'danger');
      });
  }

  return (
    <div className="nx-impersonation-banner">
      <div className="nx-impersonation-banner__message">
        <Badge tone="warning" dot>Impersonating</Badge>
        <span>
          Signed in as <strong>{info.actorName}</strong>, viewing as this user.
        </span>
        <Badge tone={info.mode === 'write' ? 'danger' : 'neutral'}>
          {info.mode === 'write' ? 'Write mode' : 'Read-only'}
        </Badge>
      </div>
      <div className="nx-impersonation-banner__actions">
        <Button size="sm" variant="ghost" onClick={handleModeToggle} disabled={changingMode || ending}>
          {info.mode === 'write' ? 'Switch to read-only' : 'Switch to write mode'}
        </Button>
        <Button size="sm" variant="danger" onClick={handleExit} disabled={ending}>
          {ending ? 'Ending…' : 'Exit impersonation'}
        </Button>
      </div>
    </div>
  );
}

// Convenience guard so App.tsx doesn't need to know the field name/shape
// beyond "does this user have one".
export function hasActiveImpersonation(user: CurrentUser): user is CurrentUser & { impersonatedBy: ImpersonationInfo } {
  return user.impersonatedBy !== undefined;
}
