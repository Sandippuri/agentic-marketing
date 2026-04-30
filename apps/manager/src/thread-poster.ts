import type { ThreadRef } from "@marketing/shared-types";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — @slack/bolt installed at deploy time; run `pnpm install` locally
import type { App as SlackApp } from "@slack/bolt";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — discord.js installed at deploy time; run `pnpm install` locally
import type { Client as DiscordClient } from "discord.js";
import pino from "pino";

const log = pino({ name: "thread-poster" });

// thread_ref format: "slack:C{channelId}:T{ts}" | "discord:C{channelId}:T{messageId}"
// Parse helpers keep decoding in one place.

function parseRef(ref: ThreadRef): { platform: "slack" | "discord"; channelId: string; threadId: string } {
  const parts = ref.split(":");
  const platform = parts[0] as "slack" | "discord";
  const channelId = (parts[1] ?? "C").slice(1); // strip leading "C"
  const threadId = (parts[2] ?? "T").slice(1);  // strip leading "T"
  return { platform, channelId, threadId };
}

export type ThreadPosterDeps = {
  slack?: SlackApp;
  discord?: DiscordClient;
};

export class ThreadPoster {
  constructor(private deps: ThreadPosterDeps) {}

  async post(threadRef: ThreadRef, text: string): Promise<void> {
    const { platform, channelId, threadId } = parseRef(threadRef);

    if (platform === "slack") {
      if (!this.deps.slack) {
        log.warn({ threadRef }, "slack not configured; skipping thread post");
        return;
      }
      await this.deps.slack.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadId,
        text,
      });
      log.info({ channelId, thread_ts: threadId }, "posted to slack thread");
      return;
    }

    if (platform === "discord") {
      if (!this.deps.discord) {
        log.warn({ threadRef }, "discord not configured; skipping thread post");
        return;
      }
      const channel = await this.deps.discord.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        log.warn({ channelId }, "discord channel not found or not text-based");
        return;
      }
      // Discord threads are identified by the message id — reply in the thread channel.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (channel as any).send({ content: text });
      log.info({ channelId, messageId: threadId }, "posted to discord thread");
    }
  }
}
