// Approval card builders for Slack (Block Kit) and Discord (embed).
// Each builder returns the platform-native payload; the bot posts it as-is.

export type ApprovalCardData = {
  approvalId: string;
  contentId: string;
  title: string;
  type: string;
  stage: string;
  bodyPreview: string; // first 300 chars of bodyMd
  campaignName: string;
  requestedAt: string;
  /** Signed URL for the visual asset preview, if any */
  assetSignedUrl?: string | null;
};

// ---------------------------------------------------------------------------
// Slack Block Kit
// ---------------------------------------------------------------------------

export function buildSlackApprovalCard(data: ApprovalCardData) {
  const preview =
    data.bodyPreview.length > 300
      ? data.bodyPreview.slice(0, 297) + "…"
      : data.bodyPreview;

  return {
    blocks: [
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
      { type: "divider" },
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
// Discord embed
// ---------------------------------------------------------------------------

const STAGE_COLOR: Record<string, number> = {
  pull: 0x6366f1,      // indigo
  explain: 0x0ea5e9,   // sky
  reinforce: 0x10b981, // emerald
  push: 0xf59e0b,      // amber
};

export function buildDiscordApprovalEmbed(data: ApprovalCardData) {
  const preview =
    data.bodyPreview.length > 300
      ? data.bodyPreview.slice(0, 297) + "…"
      : data.bodyPreview;

  const color = STAGE_COLOR[data.stage] ?? 0x6b7280;

  return {
    embeds: [
      {
        title: `📋 Review: ${data.title}`,
        description: `**Preview:**\n${preview}`,
        color,
        fields: [
          { name: "Campaign", value: data.campaignName, inline: true },
          { name: "Type", value: data.type, inline: true },
          { name: "Stage", value: data.stage, inline: true },
          {
            name: "Approval ID",
            value: `\`${data.approvalId}\``,
            inline: false,
          },
        ],
        // Show asset thumbnail if available.
        ...(data.assetSignedUrl
          ? { image: { url: data.assetSignedUrl } }
          : {}),
        footer: {
          text: `Requested ${new Date(data.requestedAt).toLocaleString()}`,
        },
      },
    ],
    // Discord doesn't have interactive buttons in the same way, so we include
    // slash-command instructions as a follow-up message.
    content: [
      "React to this message to decide:",
      "✅ `/approve " + data.approvalId + "`",
      "✏️ `/changes " + data.approvalId + " <reason>`",
      "❌ `/reject " + data.approvalId + "`",
    ].join("\n"),
  };
}
