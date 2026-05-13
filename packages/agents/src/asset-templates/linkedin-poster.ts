import type { AssetTemplate } from "./types";

/**
 * LinkedIn square poster (1080×1080).
 *
 * Top-heavy: eyebrow + headline + subline sit on a soft top gradient so the
 * generated diagram occupies the central / lower visual field. Logo bottom-center.
 */
export const linkedinPoster: AssetTemplate = {
  id: "linkedin-poster-v1",
  channel: "linkedin",
  kind: "poster",
  aspect: "square",
  canvas: { width: 1080, height: 1080 },
  slots: [
    // Full-bleed diagram fills the canvas — the chrome below sits on top.
    {
      name: "diagram",
      type: "image",
      region: { x: 0, y: 0, w: 1080, h: 1080 },
      source: { kind: "diagram" },
      fit: "cover",
    },
    // Soft top gradient header (semi-opaque → transparent) for text contrast.
    {
      name: "header-gradient",
      type: "rect",
      region: { x: 0, y: 0, w: 1080, h: 360 },
      fill: "$ink",
      opacity: 0.7,
    },
    {
      name: "eyebrow",
      type: "text",
      region: { x: 64, y: 64, w: 952, h: 28 },
      style: {
        size: 18,
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
      region: { x: 64, y: 110, w: 952, h: 200 },
      style: {
        size: 64,
        weight: 800,
        color: "#FFFFFF",
        tracking: -0.015,
        maxLines: 3,
        align: "left",
        shadow: true,
      },
      source: "slots.headline",
    },
    {
      name: "subline",
      type: "text",
      region: { x: 64, y: 920, w: 952, h: 56 },
      style: {
        size: 22,
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
      region: { x: 880, y: 990, w: 160, h: 60 },
      source: { kind: "logo", variant: "primary" },
      fit: "contain",
    },
  ],
};
