/**
 * Asset template contract.
 *
 * A template declares a fixed-size canvas and the named regions ("slots") that
 * make it up. The renderer composes the final asset by walking the slots in
 * order and painting each one:
 *   - `image` slots come from either the image generator (model fills the
 *     region at exact pixel dimensions) or from brand assets (logos).
 *   - `text` slots come from the AD brief's `slots.*` fields and are rendered
 *     deterministically with `sharp` SVG overlays — never embedded in the
 *     model output.
 *
 * Authoring rule: a template encodes a *designer's intent*, not the model's
 * imagination. The slot geometry, typography, and brand-color usage are
 * fixed at template-author time. The model's only job is the `diagram` slot.
 */

import type { VisualConceptBrief } from "../sub-agents/art-director";

/** Where a slot sits on the canvas, in pixel coordinates. */
export type SlotRegion = {
  x: number;
  y: number;
  w: number;
  h: number;
};

/** Text styling resolved at render time. */
export type TextSlotStyle = {
  /** Font size in pixels. */
  size: number;
  /** 400 (regular) – 900 (black). */
  weight: number;
  /** Hex color or a brand token like `"$ink"`, `"$accent"`. */
  color: string;
  /** Optional letter-spacing in em units (e.g. -0.015). */
  tracking?: number;
  /** Optional uppercase transform. */
  uppercase?: boolean;
  /** Max lines before ellipsizing. Defaults to 1. */
  maxLines?: number;
  /** Horizontal alignment within the slot. Defaults to "left". */
  align?: "left" | "center" | "right";
  /** Optional drop shadow for legibility on busy backgrounds. */
  shadow?: boolean;
};

/** Image-fill source: which "thing" goes into this image slot. */
export type ImageSource =
  /** Image model generates this region at exactly region.w × region.h. */
  | { kind: "diagram" }
  /** Brand asset — uses the resolved logo signed URL. */
  | { kind: "logo"; variant?: "primary" | "mark" | "wordmark" };

/** A single slot in the template. */
export type AssetSlot =
  | {
      name: string;
      type: "text";
      region: SlotRegion;
      style: TextSlotStyle;
      /** Path into the brief — e.g. `"slots.headline"`, `"slots.eyebrow"`. */
      source: string;
    }
  | {
      name: string;
      type: "image";
      region: SlotRegion;
      source: ImageSource;
      /** Optional fit when source dimensions don't match region. */
      fit?: "cover" | "contain";
    }
  | {
      name: string;
      type: "rect";
      region: SlotRegion;
      /** Hex or brand token. Used for solid color blocks behind text. */
      fill: string;
      /** Optional rounding in pixels. */
      radius?: number;
      /** Opacity 0-1. Defaults to 1. */
      opacity?: number;
    };

/** Aspect declaration — drives image-gen aspect AND determines canvas size. */
export type TemplateAspect = "square" | "landscape" | "portrait";

export type AssetTemplate = {
  /** Stable id used to reference the template (e.g. in logs and assets rows). */
  id: string;
  /** Channel the template targets. */
  channel: "linkedin" | "x" | "internal_blog" | "email_hubspot";
  /** Asset kind this template produces. */
  kind: "poster" | "og" | "email_header" | "hero";
  /** Canvas aspect — also what the image model is asked to produce for the diagram slot. */
  aspect: TemplateAspect;
  /** Canvas dimensions in pixels. */
  canvas: { width: number; height: number };
  /** Slots are painted in array order — later slots sit on top of earlier ones. */
  slots: AssetSlot[];
};

/**
 * Resolved render input. The pipeline builds this object from the brief +
 * brand tokens and hands it to the renderer.
 */
export type RenderInput = {
  template: AssetTemplate;
  brief: VisualConceptBrief;
  /** Brand color/token resolution. */
  tokens: {
    ink: string;
    accent: string;
    bg: string;
    surface: string;
    [k: string]: string;
  };
  /** Resolved logo signed URLs by variant. */
  logos: Partial<Record<"primary" | "mark" | "wordmark", string>>;
  /** PNG bytes the model produced for the `diagram` slot, sized to that slot. */
  diagramBytes: Uint8Array;
};
