import type { Channel, PublishingAdapter, AdapterPublishResult } from "@marketing/shared-types";
import pino from "pino";

const log = pino({ name: "adapter:hubspot-email" });

const API = "https://api.hubapi.com";

export type HubspotEmailPayload = {
  contentId: string;
  title: string;
  bodyMd: string;
  /** HubSpot contact list IDs to include (defaults to HUBSPOT_DEFAULT_LIST_ID env var) */
  audienceIds?: number[];
};

function mdToHtml(md: string): string {
  // Minimal Markdown → HTML for email body.
  return md
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/gs, "<ul>$&</ul>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/^(?!<[hul])(.+)$/gm, "<p>$1</p>")
    .trim();
}

async function hs<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot ${method} ${path} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * HubSpot Marketing Email adapter.
 * Requires: HUBSPOT_ACCESS_TOKEN, HUBSPOT_DEFAULT_LIST_ID (fallback contact list).
 */
export class HubspotEmailAdapter implements PublishingAdapter<HubspotEmailPayload> {
  readonly channel: Channel = "email_hubspot";

  async publish(payload: HubspotEmailPayload): Promise<AdapterPublishResult> {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) throw new Error("HUBSPOT_ACCESS_TOKEN must be set");

    const listId = payload.audienceIds?.[0]
      ?? Number(process.env.HUBSPOT_DEFAULT_LIST_ID ?? "0");
    if (!listId) throw new Error("Provide audienceIds or set HUBSPOT_DEFAULT_LIST_ID");

    log.info({ contentId: payload.contentId, listId }, "hubspot email publish");

    const bodyHtml = mdToHtml(payload.bodyMd);

    // Step 1: Create marketing email draft.
    const email = await hs<{ id: string }>("POST", "/marketing/v3/emails", token, {
      name: `${payload.title} — ${new Date().toISOString()}`,
      subject: payload.title,
      content: {
        body: bodyHtml,
        footer: "",
      },
      sendEmailSettings: {
        contactListIds: { include: [listId] },
      },
    });

    const emailId = email.id;
    log.info({ emailId }, "hubspot email draft created");

    // Step 2: Send it.
    await hs<void>("POST", `/marketing/v3/emails/${emailId}/send`, token);
    log.info({ emailId }, "hubspot email sent");

    const url = `https://app.hubspot.com/email/${process.env.HUBSPOT_PORTAL_ID ?? "0"}/details/${emailId}/performance`;
    return { externalId: emailId, externalUrl: url };
  }

  async retract(externalId: string): Promise<void> {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) throw new Error("HUBSPOT_ACCESS_TOKEN must be set");

    log.info({ externalId }, "hubspot retract (cancel)");
    await hs<void>("POST", `/marketing/v3/emails/${externalId}/cancel`, token);
    log.info({ externalId }, "hubspot email cancelled");
  }

  async fetchMetrics(externalId: string): Promise<Record<string, number>> {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) return {};

    try {
      const data = await hs<{
        counters?: {
          SENT?: number;
          DELIVERED?: number;
          OPEN?: number;
          CLICK?: number;
          UNSUBSCRIBED?: number;
          BOUNCE?: number;
        };
      }>("GET", `/marketing/v3/emails/${externalId}/statistics/summary`, token);

      const c = data.counters ?? {};
      return {
        sent: c.SENT ?? 0,
        delivered: c.DELIVERED ?? 0,
        opens: c.OPEN ?? 0,
        clicks: c.CLICK ?? 0,
        unsubscribes: c.UNSUBSCRIBED ?? 0,
        bounces: c.BOUNCE ?? 0,
      };
    } catch (err) {
      log.warn({ err: (err as Error).message, externalId }, "hubspot fetchMetrics failed");
      return {};
    }
  }
}
