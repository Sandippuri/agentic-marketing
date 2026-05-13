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
 * `"2026/04/poster-abc123.png"`. `ttlSeconds` defaults to one hour — pass a
 * longer value when the URL is going somewhere durable (KB metadata, OG tags).
 */
export async function getSignedAssetUrl(
  storagePath: string,
  ttlSeconds: number = SIGNED_URL_TTL_SECONDS,
): Promise<string> {
  const supabase = getServiceClient();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, ttlSeconds);
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

// --- Brand documents ------------------------------------------------------
// Brand-doc uploads (PDF, DOCX, MD, TXT) live in the same `assets` bucket
// under a `brand-docs/` prefix so we don't need a second bucket. Signed-URL
// helper is identical, but kept named-separately to make call-sites readable.

const BRAND_DOC_PREFIX = "brand-docs";

/** Build the canonical storage path for a brand-doc upload. */
export function brandDocStoragePath(docId: string, filename: string): string {
  // Strip path separators from the filename to keep it inside the prefix.
  const safe = filename.replace(/[\\/]+/g, "_");
  return `${BRAND_DOC_PREFIX}/${docId}/${safe}`;
}

/** Path for the parsed plaintext sidecar of a brand doc. */
export function brandDocParsedTextPath(docId: string): string {
  return `${BRAND_DOC_PREFIX}/${docId}/parsed.txt`;
}

export async function uploadBrandDoc(
  storagePath: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const supabase = getServiceClient();
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType, upsert: true });
  if (error) throw new Error(`Brand-doc upload failed: ${error.message}`);
  return storagePath;
}

export async function downloadBrandDoc(storagePath: string): Promise<Buffer> {
  const supabase = getServiceClient();
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
  if (error || !data) {
    throw new Error(`Brand-doc download failed: ${error?.message ?? "unknown"}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

export async function deleteBrandDoc(storagePath: string): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
  if (error) throw new Error(`Brand-doc delete failed: ${error.message}`);
}

export async function getSignedBrandDocUrl(storagePath: string): Promise<string> {
  // Reuse the assets bucket; same signing path.
  return getSignedAssetUrl(storagePath);
}
