// Download an image from a public URL and upload it to Supabase Storage,
// returning the storage path. The Manager doesn't import `apps/web` code
// directly, so this re-implements the upload using the Supabase REST API.

import pino from "pino";

const log = pino({ name: "asset-uploader" });
const BUCKET = "assets";

export async function uploadAsset(publicUrl: string, storagePath: string): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for asset uploads");
  }

  // Download the source image.
  const imgRes = await fetch(publicUrl);
  if (!imgRes.ok) throw new Error(`Failed to download asset from ${publicUrl}: ${imgRes.status}`);
  const buffer = await imgRes.arrayBuffer();
  const contentType = imgRes.headers.get("content-type") ?? "image/png";

  // Upload to Supabase Storage via REST API.
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${BUCKET}/${storagePath}`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: buffer,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase Storage upload → ${res.status}: ${text}`);
  }

  log.info({ storagePath, bytes: buffer.byteLength }, "asset uploaded to Supabase Storage");
  return storagePath;
}
