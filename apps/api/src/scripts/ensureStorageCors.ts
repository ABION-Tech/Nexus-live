// Pre-deploy step (runs after migrate.js on Railway). File uploads and
// previews go browser -> bucket directly via presigned URLs
// (objectStorageProvider.ts), so the bucket itself must allow the web
// app's origin (and the Android WebView's https://localhost) or every
// upload fails the CORS preflight. Idempotent: re-applies the same rule
// on each deploy. Never fails the deploy — a storage-side hiccup should
// not block the API from shipping; it logs a warning instead.
import 'dotenv/config';
import { S3Client, PutBucketCorsCommand } from '@aws-sdk/client-s3';

async function main() {
  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) {
    console.log('ensureStorageCors: STORAGE_BUCKET not set, skipping.');
    return;
  }

  const origins = [
    process.env.WEB_ORIGIN,
    ...(process.env.CORS_EXTRA_ORIGINS ?? '').split(','),
  ]
    .map((o) => o?.trim())
    .filter((o): o is string => !!o);

  const client = new S3Client({
    region: process.env.STORAGE_REGION || 'auto',
    endpoint: process.env.STORAGE_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || '',
    },
  });

  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: origins,
              AllowedMethods: ['GET', 'PUT', 'HEAD'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
    console.log(`ensureStorageCors: CORS applied to "${bucket}" for ${origins.join(', ')}.`);
  } catch (err) {
    console.warn('ensureStorageCors: could not apply bucket CORS (uploads from the browser may fail):', err);
  }
}

main().catch((err) => {
  console.warn('ensureStorageCors: unexpected error:', err);
});
