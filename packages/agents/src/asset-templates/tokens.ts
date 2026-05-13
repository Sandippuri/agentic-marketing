/**
 * Resolve brand tokens (`$ink`, `$accent`, `$bg`, `$surface`) to concrete hex
 * values from the design system. Falls back to sensible defaults when a
 * brand hasn't filled in every role — templates should always render even
 * for an under-configured brand.
 */
import type { BrandDesignSystem, DesignColor } from "@marketing/shared-types";

export type ResolvedTokens = {
  ink: string;
  accent: string;
  bg: string;
  surface: string;
};

const DEFAULTS: ResolvedTokens = {
  ink: "#0A0F1C",
  accent: "#3B82F6",
  bg: "#FFFFFF",
  surface: "#F4F4F5",
};

function findByRole(
  colors: DesignColor[],
  role: DesignColor["role"],
): string | null {
  return colors.find((c) => c.role === role)?.hex ?? null;
}

export function resolveBrandTokens(ds: BrandDesignSystem): ResolvedTokens {
  return {
    ink:
      findByRole(ds.colors, "text") ??
      findByRole(ds.colors, "primary") ??
      DEFAULTS.ink,
    accent: findByRole(ds.colors, "accent") ?? DEFAULTS.accent,
    bg: findByRole(ds.colors, "background") ?? DEFAULTS.bg,
    surface: findByRole(ds.colors, "neutral") ?? DEFAULTS.surface,
  };
}

/** Resolve a `"$ink"` / `"$accent"` token OR a literal hex string. */
export function resolveColor(value: string, tokens: ResolvedTokens): string {
  if (!value.startsWith("$")) return value;
  const key = value.slice(1) as keyof ResolvedTokens;
  return tokens[key] ?? DEFAULTS.ink;
}
