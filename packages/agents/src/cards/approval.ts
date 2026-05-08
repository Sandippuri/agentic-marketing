// Approval card builders for Slack (Block Kit) and Discord (embed).
// Each builder returns the platform-native payload; the bot posts it as-is.

import { parseRationale } from "@marketing/shared-types";

export type ApprovalCardData = {
  approvalId: string;
  contentId: string;
  title: string;
  type: string;
  stage: string;
  /** First 300 chars of bodyMd — may include a <rationale> block at the top. */
  bodyPreview: string;
  campaignName: string;
  requestedAt: string;
  /** Signed URL for the still-image asset preview, if any. */
  assetSignedUrl?: string | null;
  /** Signed URL for the promotional video (Veo 3.1), if any. */
  videoSignedUrl?: string | null;
  /** MIME type of the video (e.g. "video/mp4"). */
  videoMimeType?: string | null;
  /** Whole-second duration of the video clip. */
  videoDurationSec?: number | null;
};

// ---------------------------------------------------------------------------
// Slack Block Kit
// ---------------------------------------------------------------------------

export function buildSlackApprovalCard(data: ApprovalCardData) {
  const { rationale, bodyCopy } = parseRationale(data.bodyPreview);
  const preview =
    bodyCopy.length > 300 ? bodyCopy.slice(0, 297) + "…" : bodyCopy;

  const blocks: object[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `📋 Review: ${data.title}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Campaign:*\n${data.campaignName}` },
        {
          type: "mrkdwn",
          text: `*Type / Stage:*\n${data.type} · ${data.stage}`,
        },
      ],
    },
  ];

  // Rationale block — shown only when the AI included one.
  if (rationale) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🧠 AI Rationale:*\n_${rationale.slice(0, 280)}${rationale.length > 280 ? "…" : ""}_`,
      },
    });
  }

  blocks.push(
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Preview:*\n${preview}`,
      },
      // Attach thumbnail if an asset is available.
      ...(data.assetSignedUrl
        ? {
            accessory: {
              type: "image",
              image_url: data.assetSignedUrl,
              alt_text: "Visual asset preview",
            },
          }
        : {}),
    },
  );

  // Video block — Slack can't embed inline video, so we render a plain link
  // line that opens the signed URL in-browser.
  if (data.videoSignedUrl) {
    const dur = data.videoDurationSec ? ` · ${data.videoDurationSec}s` : "";
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `🎬 *Promo video${dur}:* <${data.videoSignedUrl}|preview>`,
        },
      ],
    });
  }

  blocks.push({ type: "divider" });

  return {
    blocks: [
      ...blocks,
      {
        type: "actions",
        block_id: `approval:${data.approvalId}`,
        elements: [
          {
            type: "button",
            action_id: "approval_approve",
            text: { type: "plain_text", text: "✅ Approve", emoji: true },
            style: "primary",
            value: JSON.stringify({ approvalId: data.approvalId, contentId: data.contentId }),
          },
          {
            type: "button",
            action_id: "approval_changes",
            text: { type: "plain_text", text: "✏️ Request changes", emoji: true },
            value: JSON.stringify({ approvalId: data.approvalId, contentId: data.contentId }),
          },
          {
            type: "button",
            action_id: "approval_reject",
            text: { type: "plain_text", text: "❌ Reject", emoji: true },
            style: "danger",
            value: JSON.stringify({ approvalId: data.approvalId, contentId: data.contentId }),
            confirm: {
              title: { type: "plain_text", text: "Reject this draft?" },
              text: { type: "mrkdwn", text: "This will reject the content item permanently." },
              confirm: { type: "plain_text", text: "Yes, reject" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          },
        ],
      },
    ],
  };
}


// ---------------------------------------------------------------------------
// Web (admin test-chat) — JSON payload the React client renders inline
// ---------------------------------------------------------------------------

export type WebApprovalCard = {
  type: "approval_card";
  approvalId: string;
  contentId: string;
  title: string;
  contentType: string;
  stage: string;
  campaignName: string;
  rationale: string | null;
  preview: string;
  assetSignedUrl: string | null;
  videoSignedUrl: string | null;
  videoMimeType: string | null;
  videoDurationSec: number | null;
  requestedAt: string;
};

export function buildWebApprovalCard(data: ApprovalCardData): WebApprovalCard {
  const { rationale, bodyCopy } = parseRationale(data.bodyPreview);
  const preview = bodyCopy.length > 600 ? bodyCopy.slice(0, 597) + "…" : bodyCopy;
  return {
    type: "approval_card",
    approvalId: data.approvalId,
    contentId: data.contentId,
    title: data.title,
    contentType: data.type,
    stage: data.stage,
    campaignName: data.campaignName,
    rationale: rationale ?? null,
    preview,
    assetSignedUrl: data.assetSignedUrl ?? null,
    videoSignedUrl: data.videoSignedUrl ?? null,
    videoMimeType: data.videoMimeType ?? null,
    videoDurationSec: data.videoDurationSec ?? null,
    requestedAt: data.requestedAt,
  };
}

// ---------------------------------------------------------------------------
// Discord embed
// ---------------------------------------------------------------------------

const STAGE_COLOR: Record<string, number> = {
  pull: 0x6366f1,      // indigo
  explain: 0x0ea5e9,   // sky
  reinforce: 0x10b981, // emerald
  push: 0xf59e0b,      // amber
};

export function buildDiscordApprovalEmbed(data: ApprovalCardData) {
  const { rationale, bodyCopy } = parseRationale(data.bodyPreview);
  const preview =
    bodyCopy.length > 300 ? bodyCopy.slice(0, 297) + "…" : bodyCopy;

  const color = STAGE_COLOR[data.stage] ?? 0x6b7280;

  const fields: object[] = [
    { name: "Campaign", value: data.campaignName, inline: true },
    { name: "Type", value: data.type, inline: true },
    { name: "Stage", value: data.stage, inline: true },
    ...(rationale
      ? [
          {
            name: "🧠 AI Rationale",
            value: rationale.slice(0, 1024),
            inline: false,
          },
        ]
      : []),
    {
      name: "Approval ID",
      value: `\`${data.approvalId}\``,
      inline: false,
    },
  ];

  // Surface the video URL as its own field — Discord can't embed video inline.
  if (data.videoSignedUrl) {
    const dur = data.videoDurationSec ? ` (${data.videoDurationSec}s)` : "";
    fields.push({
      name: `🎬 Promo video${dur}`,
      value: data.videoSignedUrl,
      inline: false,
    });
  }

  return {
    embeds: [
      {
        title: `📋 Review: ${data.title}`,
        description: `**Preview:**\n${preview}`,
        color,
        fields,
        // Show asset thumbnail if available.
        ...(data.assetSignedUrl
          ? { image: { url: data.assetSignedUrl } }
          : {}),
        footer: {
          text: `Requested ${new Date(data.requestedAt).toLocaleString()}`,
        },
      },
    ],
    content: [
      "React to this message to decide:",
      "✅ `/approve " + data.approvalId + "`",
      "✏️ `/changes " + data.approvalId + " <reason>`",
      "❌ `/reject " + data.approvalId + "`",
    ].join("\n"),
  };
}
