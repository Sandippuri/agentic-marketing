import type { Channel, PublishingAdapter, AdapterPublishResult } from "@marketing/shared-types";
import pino from "pino";

const log = pino({ name: "adapter:mailchimp" });

export type MailchimpPayload = {
  contentId: string;
  title: string;
  bodyMd: string;
  /** Mailchimp audience/list ID — defaults to MAILCHIMP_DEFAULT_LIST_ID */
  audienceId?: string;
};

function mdToHtml(md: string): string {
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

/**
 * Mailchimp Marketing API v3.0 adapter.
 * Requires: MAILCHIMP_API_KEY, MAILCHIMP_SERVER_PREFIX (e.g. "us1").
 * Optional: MAILCHIMP_DEFAULT_LIST_ID, MAILCHIMP_FROM_EMAIL, MAILCHIMP_FROM_NAME.
 */
export class MailchimpAdapter implements PublishingAdapter<MailchimpPayload> {
  readonly channel: Channel = "email_mailchimp";

  private get baseUrl(): string {
    const prefix = process.env.MAILCHIMP_SERVER_PREFIX ?? "us1";
    return `https://${prefix}.api.mailchimp.com/3.0`;
  }

  private get authHeader(): string {
    const key = process.env.MAILCHIMP_API_KEY!;
    // Mailchimp uses HTTP Basic auth with any username.
    return `Basic ${Buffer.from(`anystring:${key}`).toString("base64")}`;
  }

  private async mc<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Mailchimp ${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  async publish(payload: MailchimpPayload): Promise<AdapterPublishResult> {
    const key = process.env.MAILCHIMP_API_KEY;
    if (!key) throw new Error("MAILCHIMP_API_KEY must be set");

    const listId = payload.audienceId ?? process.env.MAILCHIMP_DEFAULT_LIST_ID;
    if (!listId) throw new Error("Provide audienceId or set MAILCHIMP_DEFAULT_LIST_ID");

    const fromEmail = process.env.MAILCHIMP_FROM_EMAIL ?? "hello@example.com";
    const fromName = process.env.MAILCHIMP_FROM_NAME ?? "Marketing";

    log.info({ contentId: payload.contentId, listId }, "mailchimp publish");

    const bodyHtml = mdToHtml(payload.bodyMd);

    // Step 1: Create campaign.
    const campaign = await this.mc<{ id: string }>("POST", "/campaigns", {
      type: "regular",
      recipients: { list_id: listId },
      settings: {
        subject_line: payload.title,
        title: `${payload.title} — ${new Date().toISOString()}`,
        from_name: fromName,
        reply_to: fromEmail,
        from_email: fromEmail,
      },
    });

    const campaignId = campaign.id;
    log.info({ campaignId }, "mailchimp campaign created");

    // Step 2: Set content.
    await this.mc<void>("PUT", `/campaigns/${campaignId}/content`, {
      html: `<!DOCTYPE html><html><body>${bodyHtml}</body></html>`,
    });

    // Step 3: Send.
    await this.mc<void>("POST", `/campaigns/${campaignId}/actions/send`);
    log.info({ campaignId }, "mailchimp campaign sent");

    const prefix = process.env.MAILCHIMP_SERVER_PREFIX ?? "us1";
    const url = `https://${prefix}.admin.mailchimp.com/reports/summary?id=${campaignId}`;
    return { externalId: campaignId, externalUrl: url };
  }

  async retract(externalId: string): Promise<void> {
    log.info({ externalId }, "mailchimp retract (cancel-send)");
    await this.mc<void>("POST", `/campaigns/${externalId}/actions/cancel-send`);
    log.info({ externalId }, "mailchimp campaign cancelled");
  }

  async fetchMetrics(externalId: string): Promise<Record<string, number>> {
    const key = process.env.MAILCHIMP_API_KEY;
    if (!key) return {};

    try {
      const data = await this.mc<{
        emails_sent?: number;
        opens?: { open_rate?: number; unique_opens?: number };
        clicks?: { click_rate?: number; unique_clicks?: number };
        unsubscribes?: number;
        bounces?: { hard_bounces?: number; soft_bounces?: number };
      }>("GET", `/reports/${externalId}`);

      return {
        sent: data.emails_sent ?? 0,
        unique_opens: data.opens?.unique_opens ?? 0,
        open_rate: Math.round((data.opens?.open_rate ?? 0) * 10000) / 100,
        unique_clicks: data.clicks?.unique_clicks ?? 0,
        click_rate: Math.round((data.clicks?.click_rate ?? 0) * 10000) / 100,
        unsubscribes: data.unsubscribes ?? 0,
        hard_bounces: data.bounces?.hard_bounces ?? 0,
        soft_bounces: data.bounces?.soft_bounces ?? 0,
      };
    } catch (err) {
      log.warn({ err: (err as Error).message, externalId }, "mailchimp fetchMetrics failed");
      return {};
    }
  }
}
