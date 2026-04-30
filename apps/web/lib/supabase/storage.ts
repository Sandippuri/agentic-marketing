import { createClient } from "@supabase/supabase-js";

// Supabase Storage helpers for the assets bucket.
// The service-role client is used server-side; signed URLs are safe to expose
// to clients (they expire and don't leak the service key).

const BUCKET = "assets";
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  return createClient(url, key);
}

/**
 * Generate a signed URL for an asset stored in Supabase Storage.
 * `storagePath` is the path within the `assets/` bucket, e.g.
 * `"2026/04/poster-abc123.png"`.
 */
export async function getSignedAssetUrl(storagePath: string): Promise<string> {
  const supabase = getServiceClient();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new Error(`Failed to sign asset URL: ${error?.message ?? "unknown"}`);
  }
  return data.signedUrl;
}

/**
 * Upload a buffer to Supabase Storage. Returns the storage path.
 * Used by the asset sub-agent after Replicate generates a background image.
 */
export async function uploadAsset(
  storagePath: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const supabase = getServiceClient();
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType, upsert: true });
  if (error) throw new Error(`Asset upload failed: ${error.message}`);
  return storagePath;
}

/**
 * Delete an asset from Supabase Storage.
 */
export async function deleteAsset(storagePath: string): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
  if (error) throw new Error(`Asset delete failed: ${error.message}`);
}
