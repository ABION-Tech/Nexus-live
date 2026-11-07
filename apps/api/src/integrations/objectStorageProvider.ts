// PRD §10.7 FileService's storage backend. S3-compatible client
// (@aws-sdk/client-s3 + @aws-sdk/s3-request-presigner) rather than any
// vendor-specific SDK — same "no vendor lock-in" stance DEPLOYMENT.md
// states for the database (`db.ts` talks plain Postgres, no Supabase
// SDK): Cloudflare R2, AWS S3, and Supabase Storage's own S3-compatible
// endpoint all speak this same protocol, so switching providers is a
// STORAGE_* env var change, never a code change, matching how
// DATABASE_URL is the only thing that moves between deployment paths.
//
// Only ever presigns URLs (pure local SigV4 crypto, no network call) —
// this process never touches file bytes. See fileService.ts's two-phase
// upload comment for why (PRD §13.4: a large file body should never
// transit this Node process).
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const UPLOAD_URL_TTL_SECONDS = 300;
const DOWNLOAD_URL_TTL_SECONDS = 300;

function client(): S3Client {
  // Constructed lazily, not at module load, so importing this file (e.g.
  // from a test that mocks it) never requires STORAGE_* to be set.
  return new S3Client({
    region: process.env.STORAGE_REGION || 'auto', // R2 accepts 'auto'; real S3 needs a real region
    endpoint: process.env.STORAGE_ENDPOINT, // unset = AWS S3's own default endpoint resolution
    forcePathStyle: true, // required for R2/Supabase Storage; harmless no-op on real S3
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || '',
    },
  });
}

function bucket(): string {
  const b = process.env.STORAGE_BUCKET;
  if (!b) throw new Error('STORAGE_BUCKET is not set.');
  return b;
}

export const objectStorageProvider = {
  async getUploadUrl(storageKey: string, mimeType: string): Promise<string> {
    const cmd = new PutObjectCommand({ Bucket: bucket(), Key: storageKey, ContentType: mimeType });
    return getSignedUrl(client(), cmd, { expiresIn: UPLOAD_URL_TTL_SECONDS });
  },

  async getDownloadUrl(storageKey: string): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: bucket(), Key: storageKey });
    return getSignedUrl(client(), cmd, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
  },

  // Not called anywhere yet — archiveFile in fileService.ts deliberately
  // doesn't delete the underlying object (see its own comment). Kept
  // here, unused, for whenever a real retention/GDPR requirement makes
  // hard deletion an actual requirement rather than a hypothetical one.
  async deleteObject(storageKey: string): Promise<void> {
    const cmd = new DeleteObjectCommand({ Bucket: bucket(), Key: storageKey });
    await client().send(cmd);
  },
};
