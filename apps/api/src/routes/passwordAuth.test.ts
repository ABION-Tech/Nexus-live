// Session 54 — member password sign-in routes. The service itself (hashing,
// one-time links, invite acceptance, no account enumeration) was exercised
// against live Postgres in Session 54; these cover the HTTP contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../services/passwordAuthService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/passwordAuthService.js')>('../services/passwordAuthService.js');
  return {
    ...actual,
    loginWithPassword: vi.fn(async (email: string, password: string) =>
      email === 'me@abion.test' && password === 'correct horse battery' ? { userId: 'u1', orgId: 'o1' } : null
    ),
    requestPasswordLink: vi.fn(async () => undefined),
    setPasswordWithToken: vi.fn(async (p: { token: string; password: string }) => {
      if (p.password.length < 10) throw new actual.PasswordAuthError('weak_password', 'Use at least 10 characters.');
      if (p.token !== 'good') throw new actual.PasswordAuthError('invalid_token', 'expired');
      return { userId: 'u1', orgId: 'o1', createdAccount: false };
    }),
  };
});

vi.mock('../services/sessionService.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/sessionService.js');
  return {
    ...actual,
    createSession: vi.fn(async () => ({ sessionId: 's1', token: 'session-token', expiresAt: new Date(Date.now() + 3600_000) })),
    verifySession: vi.fn(async () => null),
  };
});

vi.mock('../db.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) }, withOrgContext: vi.fn() }));

import { requestPasswordLink, setPasswordWithToken } from '../services/passwordAuthService.js';

describe('Session 54 — password sign-in routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COOKIE_SECRET = 'test-secret';
    const { buildServer } = await import('../server.js');
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('GET /auth/methods reports Google only when its client ID is set', async () => {
    const prev = process.env.GOOGLE_OAUTH_CLIENT_ID;
    process.env.GOOGLE_OAUTH_CLIENT_ID = '';
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/methods' })).json()).toEqual({ google: false, password: true });
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'abc.apps.googleusercontent.com';
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/methods' })).json()).toEqual({ google: true, password: true });
    process.env.GOOGLE_OAUTH_CLIENT_ID = prev;
  });

  it('logs in with the right password and sets an httpOnly session cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { email: 'me@abion.test', password: 'correct horse battery' } });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'nexus_session');
    expect(cookie?.value).toBe('session-token');
    expect(cookie?.httpOnly).toBe(true);
  });

  it('gives the same 401 for a wrong password and an unknown email, and sets no cookie', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { email: 'me@abion.test', password: 'nope nope nope' } });
    const b = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { email: 'ghost@abion.test', password: 'correct horse battery' } });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json()).toEqual(b.json());
    expect(a.cookies.find((c) => c.name === 'nexus_session')).toBeUndefined();
  });

  it('400s a missing field', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { email: 'me@abion.test' } })).statusCode).toBe(400);
  });

  it('password/request always answers the same way', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/v1/auth/password/request', payload: { email: 'me@abion.test' } });
    const b = await app.inject({ method: 'POST', url: '/api/v1/auth/password/request', payload: { email: 'ghost@abion.test' } });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual(b.json());
    expect(requestPasswordLink).toHaveBeenCalledTimes(2);
  });

  it('password/set signs the person in on success', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/password/set', payload: { token: 'good', password: 'correct horse battery' } });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === 'nexus_session')?.value).toBe('session-token');
    expect(setPasswordWithToken).toHaveBeenCalledWith({ token: 'good', password: 'correct horse battery', name: undefined });
  });

  it('password/set: 400 weak password, 410 used/expired link, no cookie', async () => {
    const weak = await app.inject({ method: 'POST', url: '/api/v1/auth/password/set', payload: { token: 'good', password: 'short' } });
    expect(weak.statusCode).toBe(400);
    const stale = await app.inject({ method: 'POST', url: '/api/v1/auth/password/set', payload: { token: 'old', password: 'correct horse battery' } });
    expect(stale.statusCode).toBe(410);
    expect(stale.cookies.find((c) => c.name === 'nexus_session')).toBeUndefined();
  });
});
