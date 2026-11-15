// Session 60 (C-09) — AI provider keys encrypted at rest.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { decryptSecret, encryptSecret, isEncrypted } from './secretBox.js';

const KEY = crypto.randomBytes(32).toString('base64');

describe('secretBox', () => {
  afterEach(() => {
    delete process.env.SECRET_ENCRYPTION_KEY;
  });

  it('round-trips, and never stores the key itself', () => {
    process.env.SECRET_ENCRYPTION_KEY = KEY;
    const stored = encryptSecret('sk-live-123');
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain('sk-live-123');
    expect(decryptSecret(stored)).toBe('sk-live-123');
  });

  it('the same key encrypts differently each time', () => {
    process.env.SECRET_ENCRYPTION_KEY = KEY;
    expect(encryptSecret('x')).not.toBe(encryptSecret('x'));
  });

  it('a key saved before encryption still reads back', () => {
    process.env.SECRET_ENCRYPTION_KEY = KEY;
    expect(decryptSecret('sk-old-plain')).toBe('sk-old-plain');
  });

  it('tampering is detected', () => {
    process.env.SECRET_ENCRYPTION_KEY = KEY;
    const stored = encryptSecret('sk-live-123');
    const parts = stored.split('.');
    parts[2] = Buffer.from('sk-live-999').toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });

  it('a different key cannot read it', () => {
    process.env.SECRET_ENCRYPTION_KEY = KEY;
    const stored = encryptSecret('sk-live-123');
    process.env.SECRET_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    expect(() => decryptSecret(stored)).toThrow();
  });

  it('without a key: stores as before, but refuses to pretend it can read an encrypted value', () => {
    expect(encryptSecret('sk-plain')).toBe('sk-plain');
    expect(() => decryptSecret('enc:v1:a.b.c')).toThrow(/SECRET_ENCRYPTION_KEY/);
  });

  it('rejects a key of the wrong length', () => {
    process.env.SECRET_ENCRYPTION_KEY = Buffer.from('short').toString('base64');
    expect(() => encryptSecret('x')).toThrow(/32 bytes/);
  });
});
