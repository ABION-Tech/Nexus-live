import { Avatar, Badge, Button, Card, useToast } from '../../components/ui';
import { logout } from '../../services/authService';
import type { CurrentUser } from '../../services/authService';

const ROLE_LABELS: Record<string, string> = {
  leader: 'Leader',
  team_member: 'Team member',
  intern: 'Intern',
};

// PRD §7.2 11 SETTINGS → Account (profile, password/auth). Google OAuth
// is the only login path in production (PRD §10.1/§13.2) — "the leader
// passphrase system is retired without a replacement" — so there's no
// password field to manage here; this is profile display + sign-out.
export function Account({ user }: { user: CurrentUser }) {
  const { show } = useToast();

  function handleLogout() {
    logout()
      .then(() => window.location.reload())
      .catch(() => show('Failed to sign out.', 'danger'));
  }

  return (
    <div className="nx-page nx-view-enter">
      <h2>Account</h2>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Avatar name={user.name} size="lg" />
          <div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{user.name}</div>
            <div style={{ opacity: 0.7 }}>{user.email}</div>
          </div>
        </div>
        <div>
          <Badge tone="info">{ROLE_LABELS[user.role] ?? user.role}</Badge>
        </div>
        <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>
          Signed in with Google. NEXUS doesn't manage a separate password — sign-in is handled entirely
          by your Google account.
        </p>
        <div>
          <Button variant="secondary" onClick={handleLogout}>Sign out</Button>
        </div>
      </Card>
    </div>
  );
}
