// Template rendering via Bannerbear or Placid.
// Activate by setting BANNERBEAR_API_KEY or PLACID_API_TOKEN in env.
//
// Phase 6.5 Day 5: implement whichever is chosen from the pre-flight checklist.

import pino from "pino";

const log = pino({ name: "template-render" });

export type TemplateFields = Record<string, string | { text?: string; image_url?: string }>;

export type RenderResult = {
  /** Public URL of the rendered PNG */
  url: string;
  /** Unique render ID from the provider */
  renderId: string;
};

// ---------------------------------------------------------------------------
// Bannerbear
// ---------------------------------------------------------------------------

async function renderBannerbear(templateId: string, modifications: TemplateFields): Promise<RenderResult> {
  const key = process.env.BANNERBEAR_API_KEY!;
  const mods = Object.entries(modifications).map(([name, value]) => {
    if (typeof value === "string") return { name, text: value };
    return { name, ...value };
  });

  const res = await fetch("https://api.bannerbear.com/v2/images", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      template: templateId,
      modifications: mods,
      synchronous: true, // wait for the image before returning
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Bannerbear render → ${res.status}: ${text}`);
  }

  const data = await res.json() as { uid: string; image_url: string | null; status: string };

  if (data.status !== "completed" || !data.image_url) {
    throw new Error(`Bannerbear render not ready: status=${data.status}`);
  }

  log.info({ templateId, renderId: data.uid }, "bannerbear render complete");
  return { url: data.image_url, renderId: data.uid };
}

// ---------------------------------------------------------------------------
// Placid
// ---------------------------------------------------------------------------

async function renderPlacid(templateId: string, modifications: TemplateFields): Promise<RenderResult> {
  const token = process.env.PLACID_API_TOKEN!;
  const layers: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(modifications)) {
    if (typeof value === "string") {
      layers[key] = { text: value };
    } else {
      layers[key] = value;
    }
  }

  const res = await fetch("https://api.placid.app/api/rest/images", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      template_uuid: templateId,
      layers,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Placid render → ${res.status}: ${text}`);
  }

  const data = await res.json() as { id: number; image_url: string | null; status: string };

  if (!data.image_url) {
    throw new Error(`Placid render returned no image_url (status=${data.status})`);
  }

  log.info({ templateId, renderId: data.id }, "placid render complete");
  return { url: data.image_url, renderId: String(data.id) };
}

// ---------------------------------------------------------------------------
// Public entry point — auto-selects provider based on env vars.
// ---------------------------------------------------------------------------

export async function renderTemplate(
  templateId: string,
  fields: TemplateFields,
): Promise<RenderResult> {
  if (process.env.BANNERBEAR_API_KEY) return renderBannerbear(templateId, fields);
  if (process.env.PLACID_API_TOKEN) return renderPlacid(templateId, fields);
  throw new Error("Neither BANNERBEAR_API_KEY nor PLACID_API_TOKEN is set (Phase 6.5 Day 2)");
}
