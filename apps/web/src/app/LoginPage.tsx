import { useEffect, useState } from 'react';
import { Card } from '../components/ui';
import { googleSignInUrl, isNativePlatform, startMobileGoogleSignIn, fetchDevRoster, devLogin, type DevRosterUser } from '../services/authService';

// App-shell level, not a PRD-numbered module — login sits outside the
// 11-section IA entirely (PRD §10.1: Google OAuth is the only production
// login path). On web this is a plain `<a>` to googleSignInUrl, not an
// onClick handler: it has to be a real browser navigation to start the
// OAuth redirect chain (routes/auth.ts's /google/start → Google's consent
// screen → /google/callback). On native (Capacitor), navigating this
// WebView the same way doesn't work — Google refuses OAuth from embedded
// WebViews — so isNativePlatform branches to a button that opens the
// same URL in the system browser instead (see authService.ts's
// startMobileGoogleSignIn for the rest of that flow).
//
// The roster picker below is the DEV_LOGIN=true fallback (routes/
// devAuth.ts) — it's fetched, not assumed present: a production API
// (or any dev API without DEV_LOGIN set) 404s the roster call and this
// page renders exactly as before, Google button only. No password
// field anywhere — picking a roster name IS the login, on purpose.
export function LoginPage() {
  const [roster, setRoster] = useState<DevRosterUser[] | null>(null);
  const [selected, setSelected] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDevRoster().then((users) => {
      setRoster(users);
      const first = users?.[0];
      if (first) setSelected(first.id);
    });
  }, []);

  async function handleDevLogin() {
    if (!selected) return;
    setLoggingIn(true);
    setError(null);
    try {
      await devLogin(selected);
      window.location.href = '/';
    } catch {
      setError('Could not log in as that user.');
      setLoggingIn(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <Card style={{ maxWidth: 380, width: '100%', textAlign: 'center' }}>
        <h1 style={{ marginBottom: 4, letterSpacing: '0.02em' }}>NEXUS</h1>
        <p style={{ color: 'var(--muted)', marginBottom: 24 }}>Sign in to continue.</p>
        {isNativePlatform ? (
          <button
            onClick={() => {
              void startMobileGoogleSignIn();
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              width: '100%',
              padding: '10px 16px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--text)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Sign in with Google
          </button>
        ) : (
          <a
            href={googleSignInUrl}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              width: '100%',
              padding: '10px 16px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--text)',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Sign in with Google
          </a>
        )}
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 16 }}>
          Not on the roster yet? Ask a leader to add you first.
        </p>

        {roster && roster.length > 0 && (
          <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px dashed var(--border)', textAlign: 'left' }}>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8, fontWeight: 600 }}>
              DEV LOGIN — local testing only, no password
            </p>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--text)',
                marginBottom: 8,
              }}
            >
              {roster.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} — {u.email}
                </option>
              ))}
            </select>
            <button
              onClick={handleDevLogin}
              disabled={loggingIn}
              style={{
                width: '100%',
                padding: '10px 16px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--text)',
                fontWeight: 600,
                cursor: loggingIn ? 'default' : 'pointer',
              }}
            >
              {loggingIn ? 'Logging in…' : 'Continue as selected user'}
            </button>
            {error && (
              <p style={{ color: 'var(--danger, #c33)', fontSize: 12, marginTop: 8 }}>{error}</p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
