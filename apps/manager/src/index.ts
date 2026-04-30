import { initTelemetry } from "./telemetry";
initTelemetry();

import pino from "pino";
import IORedis from "ioredis";
import { CpClient } from "@marketing/cp-client";
import { createSlackBot } from "./bot/slack";
import { createDiscordBot, registerDiscordSlashCommands } from "./bot/discord";
import { ThreadPoster } from "./thread-poster";
import { runOrchestrator } from "./orchestrator";
import { startWeeklyCron } from "./cron";
import { startHttpServer } from "./http-server";

const log = pino({ name: "manager" });

const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

if (!internalToken) {
  log.warn("INTERNAL_API_TOKEN unset; CP calls will be rejected");
}

const cp = new CpClient({ baseUrl, internalToken });

// Redis used for thread-state persistence across restarts.
export const redis = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

// Shared mention handler — called by both Slack and Discord.
// Phase 2 Day 1: echo back the text.
// Phase 3 Day 1+: replaced by runOrchestrator.
async function onMention(params: {
  text: string;
  userId: string;
  threadRef: string;
  reply: (msg: string) => Promise<void>;
}) {
  const { text, userId, threadRef, reply } = params;
  log.info({ userId, threadRef, text }, "mention received");

  // Persist thread state in Redis so a restart doesn't lose context.
  const stateKey = `thread:${threadRef}`;
  const stored = await redis.get(stateKey).catch(() => null);
  const history: Array<{ role: string; content: string }> = stored
    ? (JSON.parse(stored) as Array<{ role: string; content: string }>)
    : [];
  history.push({ role: "user", content: text });

  try {
    const responseText = await runOrchestrator({ text, userId, threadRef: threadRef as never, history, cp });
    history.push({ role: "assistant", content: responseText });
    // Keep at most 40 turns in memory to cap Redis key size.
    const trimmed = history.slice(-40);
    await redis.set(stateKey, JSON.stringify(trimmed), "EX", 60 * 60 * 24 * 7);
    await reply(responseText);
  } catch (err) {
    log.error({ err }, "orchestrator error");
    await reply("Something went wrong. Try again or check the admin UI.");
  }
}

async function main() {
  log.info({ baseUrl, redisUrl }, "manager booting");

  // Connect Redis (lazy — won't fail hard if unavailable yet).
  await redis.connect().catch((err: Error) => {
    log.warn({ err: err.message }, "redis connect failed; thread state won't persist");
  });

  const poster = new ThreadPoster({});

  // Wire Slack if credentials are present.
  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    const slackApp = createSlackBot(onMention, cp);
    poster["deps"] = { ...poster["deps"], slack: slackApp };
    await slackApp.start();
    log.info("slack bot started (socket mode)");
  } else {
    log.warn("SLACK_BOT_TOKEN / SLACK_APP_TOKEN not set; Slack bot disabled");
  }

  // Wire Discord if token is present.
  if (process.env.DISCORD_BOT_TOKEN) {
    const discordClient = createDiscordBot(onMention, cp);
    poster["deps"] = { ...poster["deps"], discord: discordClient };
    // Register slash commands on startup if CLIENT_ID is set.
    if (process.env.DISCORD_CLIENT_ID) {
      await registerDiscordSlashCommands(
        process.env.DISCORD_BOT_TOKEN,
        process.env.DISCORD_CLIENT_ID,
        process.env.DISCORD_GUILD_ID,
      ).catch((e: Error) => log.warn({ err: e.message }, "slash command registration failed"));
    }
    await discordClient.login(process.env.DISCORD_BOT_TOKEN);
    log.info("discord bot started");
  } else {
    log.warn("DISCORD_BOT_TOKEN not set; Discord bot disabled");
  }

  // Start internal HTTP server for CP → Manager notifications.
  startHttpServer(poster, internalToken);

  // Start weekly analyst cron — posts to first available marketing channel.
  const marketingChannel = process.env.MARKETING_SLACK_CHANNEL_ID
    ?? process.env.MARKETING_DISCORD_CHANNEL_ID;
  if (marketingChannel) {
    const platform = process.env.MARKETING_SLACK_CHANNEL_ID ? "slack" : "discord";
    startWeeklyCron(cp, async (msg) => {
      if (platform === "slack" && process.env.SLACK_BOT_TOKEN) {
        const slackApp = createSlackBot(onMention, cp);
        await slackApp.client.chat.postMessage({ channel: marketingChannel, text: msg });
      } else {
        log.info({ msg: msg.slice(0, 80) }, "weekly report (no channel configured to post)");
      }
    });
  } else {
    log.warn("MARKETING_SLACK_CHANNEL_ID / MARKETING_DISCORD_CHANNEL_ID not set; weekly cron disabled");
  }

  // Keep process alive if neither bot is configured (dev heartbeat).
  if (!process.env.SLACK_BOT_TOKEN && !process.env.DISCORD_BOT_TOKEN) {
    log.info("no bot tokens set — running in stub mode (heartbeat only)");
    setInterval(() => log.debug("heartbeat"), 60_000);
  }
}

main().catch((err) => {
  log.error(err, "manager fatal");
  process.exit(1);
});

export { cp };
