// Session 60 (C-09) — encryption at rest for secrets NEXUS must read back
// (today: each company's AI provider API key, ai_settings.api_key).
//
// AES-256-GCM. The key is SECRET_ENCRYPTION_KEY (32 random bytes, base64),
// held only in Railway's variables — never in the database or the repo, so
// a database dump alone doesn't reveal anyone's AI key. Stored form:
//   enc:v1:<iv base64url>.<auth tag base64url>.<ciphertext base64url>
// A value without the prefix is a key saved before encryption existed; it
// is read as-is and encrypted the next time it's saved (or by
// scripts/ensureEncryptedSecrets.ts at deploy).
//
// Without SECRET_ENCRYPTION_KEY, new values are stored as before (plain)
// and a warning is logged — so a missing variable degrades, never breaks
// sign-in or AI for a company. Reading an encrypted value without the key
// is an error: it can't be recovered without it.
import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';

function loadKey(): Buffer | null {
  const raw = process.env.SECRET_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('SECRET_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
  return key;
}

let warned = false;

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Encrypts `plain` when a key is configured; otherwise returns it as-is. */
export function encryptSecret(plain: string): string {
  if (isEncrypted(plain)) return plain;
  const key = loadKey();
  if (!key) {
    if (!warned) {
      warned = true;
      console.warn('SECRET_ENCRYPTION_KEY is not set: AI provider keys are being stored unencrypted.');
    }
    return plain;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

/** Decrypts a stored value; a legacy plain value is returned unchanged. */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const key = loadKey();
  if (!key) throw new Error('This secret is encrypted but SECRET_ENCRYPTION_KEY is not set.');
  const [ivText, tagText, ctText] = stored.slice(PREFIX.length).split('.');
  if (!ivText || !tagText || ctText === undefined) throw new Error('Encrypted secret is malformed.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctText, 'base64url')), decipher.final()]).toString('utf8');
}
