import { Link } from 'react-router-dom';
import { Card } from '../../components/ui';

const LINKS: { to: string; title: string; description: string }[] = [
  { to: '/settings', title: 'Integrations', description: 'Google Calendar and other connected services.' },
  { to: '/settings/team', title: 'Team & Roles', description: 'View the roster and manage per-resource permission grants.' },
  { to: '/settings/guests', title: 'Guest Invites', description: 'Generate password-capable guest credentials for external collaborators.' },
  { to: '/settings/account', title: 'Account', description: 'Your own profile and sign-out.' },
];

// Company Admin > Settings — deliberately a set of links into the
// existing Settings section rather than a rebuild. Per the guide,
// Company Admin's shell "wraps" People/Work/Goals/Knowledge (they stay
// on their own top-level sidebar sections); Settings is the same
// story — TeamRoles.tsx, Account.tsx, and the new GuestInvites.tsx
// already exist as real modules with their own routes, so this tab is
// a landing point into them, not a fourth copy of TeamRoles' drawer UI.
export function CompanySettings() {
  return (
    <div className="nx-page nx-view-enter">
      <h2>Settings</h2>
      <div className="nx-stack nx-stack--sm">
        {LINKS.map((link) => (
          <Link key={link.to} to={link.to} style={{ textDecoration: 'none', color: 'inherit' }}>
            <Card interactive style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <strong>{link.title}</strong>
              <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>{link.description}</span>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
