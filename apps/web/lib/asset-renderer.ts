/**
 * Slot-driven asset renderer.
 *
 * Given a template (declarative slot layout), a brief (the AD's authored
 * copy), brand tokens, and the bytes the image model produced for the
 * `diagram` slot, this composes the final asset PNG.
 *
 * Painting order = `template.slots` array order. Later slots sit on top of
 * earlier ones (the standard layering rule for compositors). Text auto-fits
 * its slot by stepping the font size down until the wrapped block fits both
 * width and maxLines, never overflows because the SVG uses a viewBox + clip.
 */
import sharp from "sharp";
import type {
  AssetTemplate,
  TextSlotStyle,
} from "@marketing/agents/asset-templates";
import type { VisualConceptBrief } from "@marketing/agents/sub-agents/art-director";
import {
  resolveColor,
  type ResolvedTokens,
} from "@marketing/agents/asset-templates/tokens";

export type RenderTemplateInput = {
  template: AssetTemplate;
  brief: VisualConceptBrief;
  tokens: ResolvedTokens;
  /** Resolved signed URLs for logo variants. */
  logos: Partial<Record<"primary" | "mark" | "wordmark", string>>;
  /** Raw bytes the image model produced for the diagram slot. */
  diagramBytes: Uint8Array;
};

export type RenderTemplateResult = {
  bytes: Uint8Array;
  mimeType: "image/png";
  width: number;
  height: number;
};

const FONT_STACK =
  "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";

const DEFAULT_FAMILY = FONT_STACK;
// Approximate em-width of an average glyph in our sans stack — used to
// estimate wrap line length without measuring (librsvg can't measure).
const AVG_GLYPH_EM = 0.52;

export async function renderAssetTemplate(
  input: RenderTemplateInput,
): Promise<RenderTemplateResult> {
  const { template, brief, tokens, logos, diagramBytes } = input;
  const { width, height } = template.canvas;

  // Start with the diagram resized to the canvas. Cover-fit so any
  // model-output that isn't exactly canvas-aspect crops cleanly.
  const base = sharp(Buffer.from(diagramBytes))
    .resize({
      width,
      height,
      fit: "cover",
      position: "centre",
    });

  const overlays: sharp.OverlayOptions[] = [];

  for (const slot of template.slots) {
    if (slot.type === "image" && slot.source.kind === "diagram") {
      // Already painted as the canvas — skip.
      continue;
    }
    if (slot.type === "image" && slot.source.kind === "logo") {
      const variant = slot.source.variant ?? "primary";
      const url = logos[variant] ?? logos.primary;
      if (!url) continue;
      const ov = await buildLogoOverlay(url, slot.region, slot.fit);
      if (ov) overlays.push(ov);
      continue;
    }
    if (slot.type === "rect") {
      overlays.push(
        buildRectOverlay({
          width: slot.region.w,
          height: slot.region.h,
          fill: resolveColor(slot.fill, tokens),
          radius: slot.radius ?? 0,
          opacity: slot.opacity ?? 1,
          top: slot.region.y,
          left: slot.region.x,
        }),
      );
      continue;
    }
    if (slot.type === "text") {
      const raw = readBriefPath(brief, slot.source);
      if (!raw) continue;
      const text = slot.style.uppercase ? raw.toUpperCase() : raw;
      overlays.push(
        buildTextOverlay({
          text,
          style: slot.style,
          region: slot.region,
          color: resolveColor(slot.style.color, tokens),
        }),
      );
      continue;
    }
  }

  const out = await base
    .composite(overlays)
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: new Uint8Array(out.data),
    mimeType: "image/png",
    width: out.info.width,
    height: out.info.height,
  };
}

// ============================================================
// Helpers
// ============================================================

/**
 * Walk a dotted path into the brief. Only the `slots.*` family is supported
 * today — templates declare `source: "slots.headline"` etc. Returns "" when
 * the path doesn't resolve or the value is empty.
 */
function readBriefPath(brief: VisualConceptBrief, path: string): string {
  const parts = path.split(".");
  let cur: unknown = brief;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as object)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return "";
    }
  }
  return typeof cur === "string" ? cur : "";
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapToWidth(
  text: string,
  fontSize: number,
  maxWidth: number,
): string[] {
  const charsPerLine = Math.max(
    6,
    Math.floor(maxWidth / (fontSize * AVG_GLYPH_EM)),
  );
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (!current) {
      current = w;
      continue;
    }
    if ((current + " " + w).length <= charsPerLine) {
      current += " " + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Step the font size down until the wrapped block fits the slot's width and
 * maxLines. Ellipsizes if even the smallest size overflows so we never
 * render outside the slot rect.
 */
function fitText(args: {
  text: string;
  style: TextSlotStyle;
  region: { w: number; h: number };
}): { lines: string[]; fontSize: number; lineHeight: number } {
  const maxLines = args.style.maxLines ?? 1;
  // Try the declared size first, then step down ~12% at a time.
  const steps = [1, 0.88, 0.78, 0.7, 0.62, 0.55, 0.5];
  let chosen: { lines: string[]; fontSize: number; lineHeight: number } | null = null;
  for (const step of steps) {
    const fontSize = Math.max(10, Math.round(args.style.size * step));
    const lineHeight = Math.round(fontSize * 1.16);
    const lines = wrapToWidth(args.text, fontSize, args.region.w);
    const fits =
      lines.length <= maxLines && lines.length * lineHeight <= args.region.h;
    chosen = { lines, fontSize, lineHeight };
    if (fits) return chosen;
  }
  // Hard ellipsize the last visible line.
  const fallback = chosen!;
  if (fallback.lines.length > maxLines) {
    fallback.lines = fallback.lines.slice(0, maxLines);
    const tail = fallback.lines[maxLines - 1] ?? "";
    fallback.lines[maxLines - 1] = tail.replace(/[\s.,;:]+$/, "") + "…";
  }
  return fallback;
}

function buildTextOverlay(args: {
  text: string;
  style: TextSlotStyle;
  region: { x: number; y: number; w: number; h: number };
  color: string;
}): sharp.OverlayOptions {
  const { text, style, region, color } = args;
  const fit = fitText({ text, style, region: { w: region.w, h: region.h } });
  const align = style.align ?? "left";
  const anchor =
    align === "center" ? "middle" : align === "right" ? "end" : "start";
  const anchorX =
    align === "center" ? region.w / 2 : align === "right" ? region.w : 0;

  const totalHeight = fit.lines.length * fit.lineHeight;
  // Vertically top-align inside the slot — gives the AD's authored copy a
  // predictable position. (Bottom/center alignment can be a future style.)
  const startY = Math.round(fit.fontSize * 0.85);

  const tspans = fit.lines
    .map((line, i) => {
      const dy = i === 0 ? 0 : fit.lineHeight;
      return `<tspan x="${anchorX}" dy="${dy}">${escapeXml(line)}</tspan>`;
    })
    .join("");

  const tracking = style.tracking ? `${style.tracking}em` : "normal";
  const shadowFilter = style.shadow
    ? `<defs><filter id="sh" x="-10%" y="-10%" width="120%" height="120%">
         <feGaussianBlur in="SourceAlpha" stdDeviation="${Math.max(2, fit.fontSize * 0.05)}"/>
         <feOffset dx="0" dy="${Math.max(1, fit.fontSize * 0.04)}" result="off"/>
         <feComponentTransfer><feFuncA type="linear" slope="0.55"/></feComponentTransfer>
         <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
       </filter></defs>`
    : "";
  const filterAttr = style.shadow ? `filter="url(#sh)"` : "";

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${region.w}" height="${Math.max(totalHeight, region.h)}"
     viewBox="0 0 ${region.w} ${region.h}">
  ${shadowFilter}
  <g clip-path="inset(0)">
    <text x="${anchorX}" y="${startY}"
          fill="${color}"
          font-family="${DEFAULT_FAMILY}"
          font-size="${fit.fontSize}"
          font-weight="${style.weight}"
          text-anchor="${anchor}"
          letter-spacing="${tracking}"
          ${filterAttr}>${tspans}</text>
  </g>
</svg>`;
  return {
    input: Buffer.from(svg),
    top: region.y,
    left: region.x,
  };
}

function buildRectOverlay(args: {
  width: number;
  height: number;
  fill: string;
  radius: number;
  opacity: number;
  top: number;
  left: number;
}): sharp.OverlayOptions {
  const { width, height, fill, radius, opacity, top, left } = args;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${width}" height="${height}"
     viewBox="0 0 ${width} ${height}">
  <rect x="0" y="0" width="${width}" height="${height}"
        rx="${radius}" ry="${radius}"
        fill="${fill}" opacity="${opacity}"/>
</svg>`;
  return {
    input: Buffer.from(svg),
    top,
    left,
  };
}

async function buildLogoOverlay(
  url: string,
  region: { x: number; y: number; w: number; h: number },
  fit: "cover" | "contain" | undefined,
): Promise<sharp.OverlayOptions | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[asset-renderer] logo fetch failed: ${res.status} ${url}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const sized = await sharp(buf)
      .resize({
        width: region.w,
        height: region.h,
        fit: fit === "cover" ? "cover" : "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });
    return {
      input: sized.data,
      top: region.y + Math.round((region.h - sized.info.height) / 2),
      left: region.x + Math.round((region.w - sized.info.width) / 2),
    };
  } catch (err) {
    console.warn(
      `[asset-renderer] logo overlay skipped: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return null;
  }
}
