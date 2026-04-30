/**
 * Compute the Levenshtein edit distance between two strings.
 * Pure TypeScript — no external deps. Used to measure how much a human
 * edited an AI draft before approving, giving a quality signal for future
 * fine-tuning (low edit_distance == high-quality training pair).
 *
 * Runs in O(m * n) time and O(min(m,n)) space (two-row optimisation).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Keep the shorter string in `b` to minimise memory.
  if (a.length < b.length) [a, b] = [b, a];

  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr: number[] = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    prev.splice(0, prev.length, ...curr);
  }

  return prev[b.length] ?? 0;
}
