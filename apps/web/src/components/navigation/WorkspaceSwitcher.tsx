// Session 57 — which company you're working in, and a way to move to
// another. Sits under the logo in the sidebar (and so in the phone
// drawer too).
import { useEffect, useRef, useState } from 'react';
import { useWorkspaces } from './WorkspaceContext';
import { setHomeWorkspace, ROLE_LABEL } from '../../services/workspaceService';
import { useToast } from '../ui';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export function WorkspaceSwitcher({ disabled = false }: { disabled?: boolean }) {
  const { workspaces, invitations, current, loaded, switchTo, reload } = useWorkspaces();
  const { show } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!loaded || !current) return null;
  const others = workspaces.filter((w) => !w.isCurrent);
  const canOpen = !disabled && (others.length > 0 || !current.isHome);

  async function go(orgId: string, name: string) {
    setBusy(orgId);
    try {
      await switchTo(orgId);
    } catch (err) {
      setBusy(null);
      show(err instanceof Error ? err.message : `Couldn't switch to ${name}.`, 'danger');
    }
  }

  async function makeHome() {
    try {
      await setHomeWorkspace(current!.orgId);
      await reload();
      show(`You'll land in ${current!.name} when you sign in.`, 'success');
    } catch {
      show("Couldn't change that. Try again.", 'danger');
    }
  }

  return (
    <div className="nx-ws" ref={ref}>
      <button
        type="button"
        className={'nx-ws__current' + (canOpen ? '' : ' nx-ws__current--static')}
        onClick={() => canOpen && setOpen((o) => !o)}
        aria-haspopup={canOpen ? 'menu' : undefined}
        aria-expanded={canOpen ? open : undefined}
        title={canOpen ? 'Switch company' : current.name}
      >
        <span className="nx-ws__mark" aria-hidden="true">{initials(current.name)}</span>
        <span className="nx-ws__text">
          <span className="nx-ws__name">{current.name}</span>
          <span className="nx-ws__meta">
            {others.length > 0 ? `${ROLE_LABEL[current.role] ?? current.role} · switch` : ROLE_LABEL[current.role] ?? current.role}
          </span>
        </span>
        {canOpen && (
          <svg className="nx-ws__chev" viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
          </svg>
        )}
        {invitations.length > 0 && <span className="nx-ws__dot" aria-label={`${invitations.length} invitation${invitations.length > 1 ? 's' : ''}`} />}
      </button>

      {open && (
        <div className="nx-ws__menu" role="menu">
          <div className="nx-ws__label">Your companies</div>
          {workspaces.map((w) => (
            <button
              key={w.orgId}
              type="button"
              role="menuitem"
              className={'nx-ws__item' + (w.isCurrent ? ' nx-ws__item--current' : '')}
              disabled={w.isCurrent || busy !== null}
              onClick={() => go(w.orgId, w.name)}
            >
              <span className="nx-ws__mark nx-ws__mark--sm" aria-hidden="true">{initials(w.name)}</span>
              <span className="nx-ws__text">
                <span className="nx-ws__name">{w.name}</span>
                <span className="nx-ws__meta">
                  {ROLE_LABEL[w.role] ?? w.role}
                  {w.isHome && ' · Sign-in company'}
                  {w.parentName && ` · ${w.parentName}`}
                </span>
              </span>
              {w.isCurrent ? <span className="nx-ws__tick" aria-label="Current">✓</span> : busy === w.orgId ? <span className="nx-ws__meta">Opening…</span> : null}
            </button>
          ))}
          {!current.isHome && (
            <button type="button" className="nx-ws__foot" onClick={makeHome}>
              Land in {current.name} when I sign in
            </button>
          )}
        </div>
      )}
    </div>
  );
}
