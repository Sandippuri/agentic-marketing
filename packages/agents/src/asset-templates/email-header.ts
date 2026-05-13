import type { AssetTemplate } from "./types";

/**
 * Email header banner (600×200) — narrow, single-line headline only.
 * Eyebrow + subline are skipped at this size (would be unreadable on mobile
 * email clients). Logo sits bottom-right.
 */
export const emailHeader: AssetTemplate = {
  id: "email-header-v1",
  channel: "email_hubspot",
  kind: "email_header",
  aspect: "landscape",
  canvas: { width: 600, height: 200 },
  slots: [
    {
      name: "diagram",
      type: "image",
      region: { x: 0, y: 0, w: 600, h: 200 },
      source: { kind: "diagram" },
      fit: "cover",
    },
    // Full-canvas dim so the headline reads on any background.
    {
      name: "scrim",
      type: "rect",
      region: { x: 0, y: 0, w: 600, h: 200 },
      fill: "$ink",
      opacity: 0.55,
    },
    {
      name: "headline",
      type: "text",
      region: { x: 24, y: 50, w: 440, h: 80 },
      style: {
        size: 28,
        weight: 800,
        color: "#FFFFFF",
        tracking: -0.01,
        maxLines: 2,
        align: "left",
        shadow: false,
      },
      source: "slots.headline",
    },
    {
      name: "logo",
      type: "image",
      region: { x: 470, y: 152, w: 110, h: 32 },
      source: { kind: "logo", variant: "primary" },
      fit: "contain",
    },
  ],
};
