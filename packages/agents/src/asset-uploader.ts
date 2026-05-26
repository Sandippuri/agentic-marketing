// Upload helpers for the `assets` Supabase Storage bucket. The Manager runs in
// a separate process from apps/web, so we hit the Supabase REST API directly
// using SUPABASE_SERVICE_ROLE_KEY — no @supabase/supabase-js dependency here.

import pino from "pino";

const log = pino({ name: "asset-uploader" });
const BUCKET = "assets";

function requireSupabaseEnv(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for asset uploads",
    );
  }
  return { url, key };
}

async function putBytes(
  url: string,
  serviceKey: string,
  storagePath: string,
  body: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const uploadUrl = `${url}/storage/v1/object/${BUCKET}/${storagePath}`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase Storage upload → ${res.status}: ${text}`);
  }
}

/**
 * Download an image/video from a public URL and upload it to Supabase Storage.
 * Used by Replicate-based image flows that hand back a URL.
 */
export async function uploadAsset(
  publicUrl: string,
  storagePath: string,
): Promise<string> {
  const { url, key } = requireSupabaseEnv();

  const imgRes = await fetch(publicUrl, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!imgRes.ok) {
    throw new Error(
      `Failed to download asset from ${publicUrl}: ${imgRes.status}`,
    );
  }
  const buffer = await imgRes.arrayBuffer();
  const contentType = imgRes.headers.get("content-type") ?? "image/png";

  await putBytes(url, key, storagePath, buffer, contentType);
  log.info(
    { storagePath, bytes: buffer.byteLength, contentType },
    "asset uploaded to Supabase Storage (from URL)",
  );
  return storagePath;
}

/**
 * Upload raw bytes (e.g. base64-decoded from a Gemini response) to Supabase
 * Storage. Used by the native Google image + Veo video providers.
 */
export async function uploadAssetBytes(
  bytes: Uint8Array,
  contentType: string,
  storagePath: string,
): Promise<string> {
  const { url, key } = requireSupabaseEnv();
  // Copy into a fresh ArrayBuffer so fetch's body typing is happy regardless
  // of whether the caller passed a Buffer view.
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  await putBytes(url, key, storagePath, ab, contentType);
  log.info(
    { storagePath, bytes: bytes.byteLength, contentType },
    "asset uploaded to Supabase Storage (from bytes)",
  );
  return storagePath;
}

/**
 * Land a media-generation result into Supabase regardless of whether the
 * provider returned inline bytes (Google) or a remote URL (Replicate).
 */
export async function uploadGeneratedMedia(
  result: { bytes?: Uint8Array; url?: string; mimeType: string },
  storagePath: string,
): Promise<{ storagePath: string; mimeType: string }> {
  if (result.bytes) {
    await uploadAssetBytes(result.bytes, result.mimeType, storagePath);
    return { storagePath, mimeType: result.mimeType };
  }
  if (result.url) {
    await uploadAsset(result.url, storagePath);
    return { storagePath, mimeType: result.mimeType };
  }
  throw new Error("uploadGeneratedMedia: result had neither bytes nor url");
}
