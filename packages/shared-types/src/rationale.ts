/**
 * Parse the optional <rationale>...</rationale> block that the Content and
 * Strategist sub-agents prepend to every draft.
 *
 * Returns { rationale, bodyCopy } where:
 *   rationale  — the text inside the tags (trimmed), or null if absent
 *   bodyCopy   — the bodyMd with the rationale block stripped out
 *
 * Shared between manager (card builders) and web (admin UI).
 */
export function parseRationale(bodyMd: string): {
  rationale: string | null;
  bodyCopy: string;
} {
  const match = bodyMd.match(/<rationale>([\s\S]*?)<\/rationale>/i);
  if (!match) {
    return { rationale: null, bodyCopy: bodyMd };
  }
  const rationale = match[1]?.trim() ?? null;
  // Remove the entire <rationale>...</rationale> block plus surrounding whitespace.
  const bodyCopy = bodyMd.replace(/<rationale>[\s\S]*?<\/rationale>\s*/i, "").trim();
  return { rationale, bodyCopy };
}
