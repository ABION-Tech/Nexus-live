import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Input } from '../components/ui';
import {
  googleSignInUrl,
  isNativePlatform,
  startMobileGoogleSignIn,
  fetchDevRoster,
  devLogin,
  fetchAuthMethods,
  passwordLogin,
  requestPasswordLink,
  setPasswordWithToken,
  type AuthMethods,
  type DevRosterUser,
} from '../services/authService';
import { ApiError } from '../services/apiClient';

// App-shell level, outside the IA. Session 54: email + password is now a
// sign-in path for members alongside Google (routes/auth.ts /password/*).
// A password is only ever chosen by its owner, through a one-time emailed
// link — the "Get a sign-in link" mode below covers first-time setup,
// forgotten passwords, and accepting an invite without Google.
//
// The Google button only renders when the API reports a configured OAuth
// client (GET /auth/methods); otherwise Google rejects the request with
// "Error 400: invalid_request" and the button would be a dead end.
//
// /set-password?token=… is handled here too: this page is what renders for
// any anonymous visitor, whatever the path.
//
// The roster picker is the DEV_LOGIN=true fallback (routes/devAuth.ts) —
// fetched, not assumed: a production API 404s the roster call and it
// never shows.

type Mode = 'signin' | 'link' | 'link-sent';

function messageFrom(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function LoginPage() {
  const setPasswordToken =
    typeof window !== 'undefined' && window.location.pathname === '/set-password'
      ? new URLSearchParams(window.location.search).get('token')
      : null;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <Card style={{ maxWidth: 400, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <h1 style={{ margin: 0, letterSpacing: '0.18em', fontSize: 26 }}>NEXUS</h1>
        </div>
        {setPasswordToken ? <SetPasswordForm token={setPasswordToken} /> : <SignIn />}
      </Card>
    </div>
  );
}

function SignIn() {
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roster, setRoster] = useState<DevRosterUser[] | null>(null);

  useEffect(() => {
    fetchAuthMethods().then(setMethods);
    fetchDevRoster().then(setRoster);
  }, []);

  async function handleSignIn(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await passwordLogin(email.trim(), password);
      window.location.href = '/';
    } catch (err) {
      setError(messageFrom(err, 'Could not sign in. Try again.'));
      setBusy(false);
    }
  }

  async function handleRequestLink(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Enter the email address you were invited with.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await requestPasswordLink(email.trim());
      setMode('link-sent');
    } catch (err) {
      setError(messageFrom(err, 'Could not send the link. Try again in a few minutes.'));
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'link-sent') {
    return (
      <div className="nx-stack nx-stack--md" style={{ textAlign: 'center' }}>
        <h3 style={{ margin: 0 }}>Check your inbox</h3>
        <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 14 }}>
          If <strong style={{ color: 'var(--text)' }}>{email.trim()}</strong> is on NEXUS, we've sent a link to choose your
          password. It works once and expires in an hour.
        </p>
        <Button variant="ghost" onClick={() => setMode('signin')}>Back to sign in</Button>
      </div>
    );
  }

  return (
    <div className="nx-stack nx-stack--md">
      {mode === 'signin' ? (
        <form className="nx-stack nx-stack--md" onSubmit={handleSignIn}>
          <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 14, textAlign: 'center' }}>Sign in to continue.</p>
          <Input label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <span className="nx-field__error">{error}</span>}
          <Button type="submit" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          <button
            type="button"
            onClick={() => {
              setMode('link');
              setError(null);
            }}
            style={{ background: 'none', border: 0, color: 'var(--accent)', fontSize: 13, cursor: 'pointer', padding: 0 }}
          >
            First time here, or forgot your password?
          </button>
        </form>
      ) : (
        <form className="nx-stack nx-stack--md" onSubmit={handleRequestLink}>
          <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 14 }}>
            Enter the email you were invited with. We'll send a link to choose your password.
          </p>
          <Input label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          {error && <span className="nx-field__error">{error}</span>}
          <Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Email me a link'}</Button>
          <Button variant="ghost" onClick={() => setMode('signin')}>Back to sign in</Button>
        </form>
      )}

      {methods?.google && mode === 'signin' && (
        <>
          <div className="nx-row" style={{ gap: 10, color: 'var(--text-dim)', fontSize: 12 }}>
            <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            or
            <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          </div>
          {isNativePlatform ? (
            <Button variant="secondary" onClick={() => void startMobileGoogleSignIn()}>Continue with Google</Button>
          ) : (
            <a className="nx-btn nx-btn--secondary" href={googleSignInUrl} style={{ textAlign: 'center', textDecoration: 'none' }}>
              Continue with Google
            </a>
          )}
        </>
      )}

      <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 12, textAlign: 'center' }}>
        Not on NEXUS yet? Ask your company's admin to invite you.
      </p>

      {roster && roster.length > 0 && <DevLogin roster={roster} />}
    </div>
  );
}

function SetPasswordForm({ token }: { token: string }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 10) {
      setError('Use at least 10 characters.');
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setPasswordWithToken(token, password, name.trim() || undefined);
      window.location.href = '/';
    } catch (err) {
      setError(messageFrom(err, 'Could not set your password.'));
      setBusy(false);
    }
  }

  return (
    <form className="nx-stack nx-stack--md" onSubmit={handleSubmit}>
      <div className="nx-stack nx-stack--xs">
        <h3 style={{ margin: 0 }}>Choose your password</h3>
        <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 13 }}>At least 10 characters. A short phrase is easiest to remember.</p>
      </div>
      <Input
        label="Your name (first sign-in only)"
        placeholder="How your team will see you"
        autoComplete="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Input label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <Input label="Confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      {error && <span className="nx-field__error">{error}</span>}
      <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save and sign in'}</Button>
      <a href="/" style={{ color: 'var(--text-dim)', fontSize: 13, textAlign: 'center' }}>Back to sign in</a>
    </form>
  );
}

function DevLogin({ roster }: { roster: DevRosterUser[] }) {
  const [selected, setSelected] = useState(roster[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await devLogin(selected);
      window.location.href = '/';
    } catch {
      setError('Could not log in as that user.');
      setBusy(false);
    }
  }

  return (
    <div className="nx-stack nx-stack--sm" style={{ marginTop: 8, paddingTop: 16, borderTop: '1px dashed var(--border)' }}>
      <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 12, fontWeight: 600 }}>DEV LOGIN — local testing only</p>
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="nx-select"
        style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
      >
        {roster.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name} — {u.email}
          </option>
        ))}
      </select>
      <Button variant="secondary" onClick={handle} disabled={busy}>{busy ? 'Logging in…' : 'Continue as selected user'}</Button>
      {error && <span className="nx-field__error">{error}</span>}
    </div>
  );
}
