import { useEffect, useState, type FormEvent } from 'react';
import { Avatar, Badge, Button, Card, Input, useToast } from '../../components/ui';
import { logout, requestPasswordLink } from '../../services/authService';
import type { CurrentUser } from '../../services/authService';
import { createPersonalKey, listPersonalKeys, revokePersonalKey, type PersonalKey } from '../../services/personalKeyService';

const ROLE_LABELS: Record<string, string> = {
  leader: 'Leader',
  team_member: 'Team member',
  intern: 'Intern',
};

// PRD §7.2 11 SETTINGS → Account. Session 54 added email + password
// sign-in (a password is only ever set by its owner through an emailed
// one-time link); Session 56 adds personal API keys, which let another
// app of yours (first: Synergia) read your own tasks.
export function Account({ user }: { user: CurrentUser }) {
  const { show } = useToast();
  const [linkSent, setLinkSent] = useState(false);

  function handleLogout() {
    logout()
      .then(() => window.location.reload())
      .catch(() => show('Failed to sign out.', 'danger'));
  }

  async function sendPasswordLink() {
    try {
      await requestPasswordLink(user.email);
      setLinkSent(true);
    } catch {
      show('Could not send the link. Try again in a few minutes.', 'danger');
    }
  }

  return (
    <div className="nx-page nx-view-enter">
      <h2>Account</h2>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Avatar name={user.name} size="lg" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{user.name}</div>
            <div style={{ color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{user.email}</div>
          </div>
        </div>
        <div>
          <Badge tone="info">{ROLE_LABELS[user.role] ?? user.role}</Badge>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-dim)' }}>
          You sign in with your email and a password only you choose. To change it, we'll email you a one-time link.
        </p>
        <div className="nx-row" style={{ flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={sendPasswordLink} disabled={linkSent}>
            {linkSent ? 'Link sent — check your inbox' : 'Change my password'}
          </Button>
          <Button variant="ghost" onClick={handleLogout}>Sign out</Button>
        </div>
      </Card>

      <PersonalKeys />
    </div>
  );
}

function when(iso: string | null): string {
  if (!iso) return 'Never used';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'Used just now';
  if (mins < 60) return `Used ${mins} min ago`;
  if (mins < 1440) return `Used ${Math.round(mins / 60)} h ago`;
  return `Used ${new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

function PersonalKeys() {
  const { show } = useToast();
  const [keys, setKeys] = useState<PersonalKey[] | null>(null);
  const [name, setName] = useState('Synergia');
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);

  const load = () =>
    listPersonalKeys()
      .then(setKeys)
      .catch(() => setKeys([]));
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await createPersonalKey(name.trim());
      setSecret({ name: r.key.name, value: r.secret });
      setName('');
      await load();
    } catch (err) {
      show(err instanceof Error ? err.message : 'Could not create the key.', 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: PersonalKey) {
    if (!window.confirm(`Revoke "${k.name}"? Anything using it stops working straight away.`)) return;
    try {
      await revokePersonalKey(k.id);
      show(`"${k.name}" revoked.`, 'success');
      await load();
    } catch {
      show('Could not revoke the key.', 'danger');
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      show('Key copied.', 'success');
    } catch {
      show('Copy failed — select the key and copy it by hand.', 'danger');
    }
  }

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 16 }}>Personal keys</h3>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-dim)' }}>
          A key lets another app of yours, like Synergia, read <b>your own tasks</b> in NEXUS. It can't change anything, can't see
          anyone else's work, and stops working the moment you revoke it.
        </p>
      </div>

      {secret && (
        <div style={{ border: '1px solid var(--accent2)', background: 'var(--success-bg)', borderRadius: 'var(--radius)', padding: 14 }} className="nx-stack nx-stack--sm">
          <b style={{ fontSize: 14 }}>Copy your "{secret.name}" key now</b>
          <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
            This is the only time it's shown. Paste it into Synergia → Settings → Connections → NEXUS.
          </span>
          <code
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, padding: '10px 12px', background: 'var(--bg)', borderRadius: 'var(--radius-sm)', overflowWrap: 'anywhere', userSelect: 'all' }}
          >
            {secret.value}
          </code>
          <div className="nx-row">
            <Button onClick={() => copy(secret.value)}>Copy key</Button>
            <Button variant="ghost" onClick={() => setSecret(null)}>I've saved it</Button>
          </div>
        </div>
      )}

      {keys === null ? (
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>Loading keys…</span>
      ) : keys.length === 0 ? (
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>No keys yet.</span>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {keys.map((k) => (
            <li key={k.id} className="nx-row nx-row--between" style={{ border: '1px solid var(--border2)', borderRadius: 'var(--radius)', padding: '10px 12px', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{k.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                  {k.prefix}… · reads tasks · {when(k.lastUsedAt)}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => revoke(k)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={create} className="nx-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ flex: '1 1 200px' }}>
          <Input label="New key name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Synergia" maxLength={60} />
        </div>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create key'}
        </Button>
      </form>
    </Card>
  );
}
