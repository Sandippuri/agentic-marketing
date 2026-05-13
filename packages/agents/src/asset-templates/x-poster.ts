import type { AssetTemplate } from "./types";

/**
 * X (Twitter) landscape poster (1600×900) — sized for in-feed media cards.
 * Wider than LinkedIn → headline gets two big lines, subline sits below it,
 * logo bottom-right where it doesn't fight the visual.
 */
export const xPoster: AssetTemplate = {
  id: "x-poster-v1",
  channel: "x",
  kind: "poster",
  aspect: "landscape",
  canvas: { width: 1600, height: 900 },
  slots: [
    {
      name: "diagram",
      type: "image",
      region: { x: 0, y: 0, w: 1600, h: 900 },
      source: { kind: "diagram" },
      fit: "cover",
    },
    // Left-side gradient for headline contrast — wider canvas means we don't
    // need to cover the whole top.
    {
      name: "header-gradient",
      type: "rect",
      region: { x: 0, y: 0, w: 1100, h: 360 },
      fill: "$ink",
      opacity: 0.65,
    },
    {
      name: "eyebrow",
      type: "text",
      region: { x: 80, y: 72, w: 1000, h: 28 },
      style: {
        size: 20,
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
      region: { x: 80, y: 120, w: 1020, h: 200 },
      style: {
        size: 72,
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
      name: "subline",
      type: "text",
      region: { x: 80, y: 760, w: 1100, h: 80 },
      style: {
        size: 26,
        weight: 500,
        color: "#FFFFFF",
        maxLines: 2,
        align: "left",
        shadow: true,
      },
      source: "slots.subline",
    },
    {
      name: "logo",
      type: "image",
      region: { x: 1380, y: 800, w: 160, h: 60 },
      source: { kind: "logo", variant: "primary" },
      fit: "contain",
    },
  ],
};
