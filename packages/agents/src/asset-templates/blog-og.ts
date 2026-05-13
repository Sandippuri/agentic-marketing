import type { AssetTemplate } from "./types";

/**
 * Blog Open Graph card (1200×630) — the OG default sized for FB/LinkedIn
 * link previews. Tighter than X poster, no subline by default to avoid
 * crowding the OG crop preview.
 */
export const blogOg: AssetTemplate = {
  id: "blog-og-v1",
  channel: "internal_blog",
  kind: "og",
  aspect: "landscape",
  canvas: { width: 1200, height: 630 },
  slots: [
    {
      name: "diagram",
      type: "image",
      region: { x: 0, y: 0, w: 1200, h: 630 },
      source: { kind: "diagram" },
      fit: "cover",
    },
    {
      name: "header-gradient",
      type: "rect",
      region: { x: 0, y: 0, w: 1200, h: 320 },
      fill: "$ink",
      opacity: 0.7,
    },
    {
      name: "eyebrow",
      type: "text",
      region: { x: 64, y: 64, w: 1072, h: 24 },
      style: {
        size: 16,
        weight: 700,
        color: "#FFFFFF",
        tracking: 0.18,
        uppercase: true,
        maxLines: 1,
        align: "left",
      },
      source: "slots.eyebrow",
    },
    {
      name: "headline",
      type: "text",
      region: { x: 64, y: 100, w: 1072, h: 180 },
      style: {
        size: 56,
        weight: 800,
        color: "#FFFFFF",
        tracking: -0.015,
        maxLines: 2,
        align: "left",
        shadow: true,
      },
      source: "slots.headline",
    },
    {
      name: "logo",
      type: "image",
      region: { x: 64, y: 540, w: 140, h: 50 },
      source: { kind: "logo", variant: "primary" },
      fit: "contain",
    },
  ],
};
