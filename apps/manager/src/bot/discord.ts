// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — discord.js installed at deploy time; run `pnpm install` locally
import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type Message,
  type ChatInputCommandInteraction,
} from "discord.js";
import pino from "pino";
import type { ThreadRef } from "@marketing/shared-types";
import type { CpClient } from "@marketing/cp-client";

const log = pino({ name: "discord-bot" });

export type MentionHandler = (params: {
  text: string;
  userId: string;
  threadRef: ThreadRef;
  reply: (msg: string) => Promise<void>;
}) => Promise<void>;

// Slash commands registered on startup.
const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName("approve")
    .setDescription("Approve a pending content review")
    .addStringOption((o) => o.setName("id").setDescription("Approval ID").setRequired(true)),
  new SlashCommandBuilder()
    .setName("reject")
    .setDescription("Reject a pending content review")
    .addStringOption((o) => o.setName("id").setDescription("Approval ID").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason for rejection")),
  new SlashCommandBuilder()
    .setName("changes")
    .setDescription("Request changes on a pending content review")
    .addStringOption((o) => o.setName("id").setDescription("Approval ID").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("What needs to change?").setRequired(true)),
].map((c) => c.toJSON());

export async function registerDiscordSlashCommands(token: string, clientId: string, guildId?: string) {
  const rest = new REST({ version: "10" }).setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);
  await rest.put(route, { body: SLASH_COMMANDS });
  log.info({ guildId }, "discord slash commands registered");
}

export function createDiscordBot(onMention: MentionHandler, cp?: CpClient): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    log.info({ tag: c.user.tag }, "discord bot ready");
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    // Only respond to messages that mention the bot.
    if (!client.user || !message.mentions.has(client.user)) return;
    // Never reply to other bots.
    if (message.author.bot) return;

    const channelId = message.channelId;
    const messageId = message.id;
    const threadRef = `discord:C${channelId}:T${messageId}` as ThreadRef;

    // Strip bot mention from text.
    const text = message.content
      .replace(/<@!?\d+>/g, "")
      .trim();
    const userId = message.author.id;

    log.info({ channelId, messageId, userId, text }, "discord mention received");

    await onMention({
      text,
      userId,
      threadRef,
      reply: async (msg) => {
        await message.reply(msg);
      },
    });
  });

  // ── Slash command interactions ──────────────────────────────────────────
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const i = interaction as ChatInputCommandInteraction;

    if (i.commandName === "approve") {
      const approvalId = i.options.getString("id", true);
      await i.deferReply({ ephemeral: true });
      if (!cp) { await i.editReply("CP not configured."); return; }
      try {
        await cp.decideApproval(approvalId, { decision: "approved", decidedBy: i.user.id });
        await i.editReply(`✅ Approved \`${approvalId}\``);
      } catch (err) {
        await i.editReply(`Error: ${(err as Error).message}`);
      }
      return;
    }

    if (i.commandName === "reject") {
      const approvalId = i.options.getString("id", true);
      const reason = i.options.getString("reason") ?? undefined;
      await i.deferReply({ ephemeral: true });
      if (!cp) { await i.editReply("CP not configured."); return; }
      try {
        await cp.decideApproval(approvalId, { decision: "rejected", reason, decidedBy: i.user.id });
        await i.editReply(`❌ Rejected \`${approvalId}\``);
      } catch (err) {
        await i.editReply(`Error: ${(err as Error).message}`);
      }
      return;
    }

    if (i.commandName === "changes") {
      const approvalId = i.options.getString("id", true);
      const reason = i.options.getString("reason", true);
      await i.deferReply({ ephemeral: true });
      if (!cp) { await i.editReply("CP not configured."); return; }
      try {
        await cp.decideApproval(approvalId, { decision: "changes_requested", reason, decidedBy: i.user.id });
        await i.editReply(`✏️ Changes requested on \`${approvalId}\``);
      } catch (err) {
        await i.editReply(`Error: ${(err as Error).message}`);
      }
    }
  });

  client.on(Events.Error, (err) => {
    log.error({ err: err.message }, "discord client error");
  });

  return client;
}
