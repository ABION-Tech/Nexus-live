// scrypt password hashing with a per-password random salt, stored as
// `salt_hex:hash_hex`. Originally guestService.ts's (Session 37); shared
// with member password sign-in since Session 54 — same format, so no
// stored guest credential changes.
import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  // Lengths always match (fixed SCRYPT_KEYLEN) so timingSafeEqual won't
  // throw on a length mismatch here the way it can on attacker-controlled
  // input elsewhere.
  return crypto.timingSafeEqual(expected, actual);
}

