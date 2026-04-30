// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — @slack/bolt installed at deploy time; run `pnpm install` locally
import { App, type MessageEvent } from "@slack/bolt";
import pino from "pino";
import type { ThreadRef } from "@marketing/shared-types";
import type { CpClient } from "@marketing/cp-client";

const log = pino({ name: "slack-bot" });

export type MentionHandler = (params: {
  text: string;
  userId: string;
  threadRef: ThreadRef;
  reply: (msg: string) => Promise<void>;
}) => Promise<void>;

type ActionValue = { approvalId: string; contentId: string };

function parseActionValue(value: string | undefined): ActionValue | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ActionValue;
  } catch {
    return null;
  }
}

export function createSlackBot(onMention: MentionHandler, cp?: CpClient): App {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? "unused-in-socket-mode",
    socketMode: true,
  });

  // Listen for app_mention events (bot tagged in a channel/thread).
  app.event("app_mention", async ({ event, client }) => {
    const e = event as MessageEvent & { thread_ts?: string };
    const channelId = e.channel;
    const threadTs = e.thread_ts ?? e.ts;
    const threadRef = `slack:C${channelId}:T${threadTs}` as ThreadRef;

    const text = (e.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    const userId = e.user ?? "unknown";

    log.info({ channelId, threadTs, userId, text }, "slack mention received");

    await onMention({
      text,
      userId,
      threadRef,
      reply: async (msg) => {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: msg,
        });
      },
    });
  });

  // ── Approval action: Approve ──────────────────────────────────────────────
  app.action("approval_approve", async ({ action, body, ack, respond }) => {
    await ack();
    if (!cp) return;
    const val = parseActionValue("value" in action ? (action.value as string) : undefined);
    if (!val) return;
    const userId = body.user.id;
    try {
      await cp.decideApproval(val.approvalId, { decision: "approved", decidedBy: userId });
      await respond({ text: `✅ Approved by <@${userId}>`, replace_original: false });
      log.info({ approvalId: val.approvalId, userId }, "slack approval: approved");
    } catch (err) {
      await respond({ text: `Error approving: ${(err as Error).message}`, replace_original: false });
    }
  });

  // ── Approval action: Request changes ────────────────────────────────────
  app.action("approval_changes", async ({ action, body, ack, client }) => {
    await ack();
    if (!cp) return;
    const val = parseActionValue("value" in action ? (action.value as string) : undefined);
    if (!val) return;

    // Open a modal to capture the reason.
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: `changes_modal:${val.approvalId}`,
        title: { type: "plain_text", text: "Request changes" },
        submit: { type: "plain_text", text: "Send" },
        close: { type: "plain_text", text: "Cancel" },
        private_metadata: JSON.stringify(val),
        blocks: [
          {
            type: "input",
            block_id: "reason_block",
            label: { type: "plain_text", text: "What needs to change?" },
            element: {
              type: "plain_text_input",
              action_id: "reason_input",
              multiline: true,
              placeholder: { type: "plain_text", text: "Be specific — the Content agent will read this." },
            },
          },
        ],
      },
    });
  });

  // ── Modal submission: changes reason ────────────────────────────────────
  app.view(/^changes_modal:/, async ({ view, body, ack }) => {
    await ack();
    if (!cp) return;
    const val = parseActionValue(view.private_metadata);
    if (!val) return;
    const userId = body.user.id;
    const reason =
      view.state.values["reason_block"]?.["reason_input"]?.value ?? "";
    try {
      await cp.decideApproval(val.approvalId, {
        decision: "changes_requested",
        reason,
        decidedBy: userId,
      });
      log.info({ approvalId: val.approvalId, userId }, "slack approval: changes_requested");
    } catch (err) {
      log.error({ err: (err as Error).message }, "changes_requested failed");
    }
  });

  // ── Approval action: Reject ──────────────────────────────────────────────
  app.action("approval_reject", async ({ action, body, ack, respond }) => {
    await ack();
    if (!cp) return;
    const val = parseActionValue("value" in action ? (action.value as string) : undefined);
    if (!val) return;
    const userId = body.user.id;
    try {
      await cp.decideApproval(val.approvalId, { decision: "rejected", decidedBy: userId });
      await respond({ text: `❌ Rejected by <@${userId}>`, replace_original: false });
      log.info({ approvalId: val.approvalId, userId }, "slack approval: rejected");
    } catch (err) {
      await respond({ text: `Error rejecting: ${(err as Error).message}`, replace_original: false });
    }
  });

  app.error(async (err) => {
    log.error({ err: err.message }, "slack app error");
  });

  return app;
}
