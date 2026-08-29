import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { requireStorage } from '../env.js';

/**
 * Raw file storage, on a PRIVATE Supabase bucket.
 *
 * Private matters: the browser never gets a bucket URL. It asks our API for
 * the file, and the API mints a short-lived signed URL. That keeps the
 * service-role key server-side and means access stays something we can
 * change our mind about later — a public bucket URL, once handed out, is
 * public forever.
 */

let client: SupabaseClient | null = null;

const getClient = (): { supabase: SupabaseClient; bucket: string } => {
  const { url, key, bucket } = requireStorage();
  client ??= createClient(url, key, { auth: { persistSession: false } });
  return { supabase: client, bucket };
};

/**
 * Object key for an upload.
 *
 * A UUID prefix, not the filename alone: two people uploading `invoice.pdf`
 * must not collide, and a user-supplied filename must never be able to steer
 * the path. The original name is kept on the `documents` row, which is where
 * it belongs.
 */
export const storageKeyFor = (filename: string): string => {
  const ext = extname(filename).toLowerCase().slice(0, 8);
  return `${randomUUID()}${ext}`;
};

export const upload = async (
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<string> => {
  const { supabase, bucket } = getClient();
  const { error } = await supabase.storage.from(bucket).upload(key, buffer, {
    contentType,
    upsert: false,
  });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  return key;
};

export const download = async (key: string): Promise<Buffer> => {
  const { supabase, bucket } = getClient();
  const { data, error } = await supabase.storage.from(bucket).download(key);
  if (error || !data) throw new Error(`Storage download failed: ${error?.message ?? 'no data'}`);
  return Buffer.from(await data.arrayBuffer());
};

/** Short-lived by design: long enough to open a PDF, short enough not to leak. */
export const signedUrl = async (key: string, expiresInSeconds = 300): Promise<string> => {
  const { supabase, bucket } = getClient();
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(key, expiresInSeconds);
  if (error || !data) throw new Error(`Could not sign URL: ${error?.message ?? 'no data'}`);
  return data.signedUrl;
};

/**
 * Create the bucket if it does not exist. Called at boot so a fresh Supabase
 * project works after `npm run db:migrate` without a trip through the
 * dashboard — one less step in the README that can go wrong.
 */
export const ensureBucket = async (): Promise<void> => {
  const { supabase, bucket } = getClient();
  const { data } = await supabase.storage.getBucket(bucket);
  if (data) return;
  const { error } = await supabase.storage.createBucket(bucket, { public: false });
  // A concurrent boot may have won the race; that is fine.
  if (error && !/already exists/i.test(error.message)) {
    throw new Error(`Could not create storage bucket "${bucket}": ${error.message}`);
  }
};
