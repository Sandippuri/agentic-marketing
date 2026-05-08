// Lightweight ops-alert sink. Posts to OPS_ALERT_WEBHOOK_URL (Slack incoming
// webhook format: {text}) when set; otherwise logs and returns. Process-local
// dedup window (15 min) keeps a stuck quota error from hammering the channel
// — duplicates across Vercel function instances are acceptable noise.

const lastSentAt = new Map<string, number>();
const DEDUP_WINDOW_MS = 15 * 60 * 1000;

export type AlertOptions = {
  dedupKey?: string;
  context?: Record<string, unknown>;
};

export async function notifyOps(
  message: string,
  opts: AlertOptions = {},
): Promise<void> {
  const url = process.env.OPS_ALERT_WEBHOOK_URL?.trim();

  if (opts.dedupKey) {
    const last = lastSentAt.get(opts.dedupKey);
    if (last && Date.now() - last < DEDUP_WINDOW_MS) return;
    lastSentAt.set(opts.dedupKey, Date.now());
  }

  const ctxLine = opts.context
    ? "\n" +
      Object.entries(opts.context)
        .map(
          ([k, v]) =>
            `• ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
        )
        .join("\n")
    : "";
  const body = `${message}${ctxLine}`;

  if (!url) {
    console.warn(`[alerts] OPS_ALERT_WEBHOOK_URL unset — would alert: ${body}`);
    return;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[alerts] webhook ${res.status}: ${detail.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn("[alerts] webhook failed:", err);
  }
}
