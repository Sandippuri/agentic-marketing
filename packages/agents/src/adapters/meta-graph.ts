// Shared Meta Graph API client used by both the Facebook Page and Instagram
// Business adapters. They share an access token (long-lived Page token, which
// IG Business inherits via the linked Page).

const DEFAULT_VERSION = "v21.0";

function apiBase(): string {
  const v = process.env.META_GRAPH_API_VERSION || DEFAULT_VERSION;
  return `https://graph.facebook.com/${v}`;
}

export async function metaRequest<T>(
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const url = new URL(`${apiBase()}${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    method,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Meta ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}
