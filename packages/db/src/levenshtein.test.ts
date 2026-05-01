import { describe, it, expect } from "vitest";
import { levenshtein } from "./levenshtein";

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("", "")).toBe(0);
  });

  it("returns length of a when b is empty", () => {
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("returns length of b when a is empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
  });

  it("returns 1 for a single substitution", () => {
    expect(levenshtein("cat", "bat")).toBe(1);
  });

  it("returns 1 for a single insertion", () => {
    expect(levenshtein("cat", "cats")).toBe(1);
  });

  it("returns 1 for a single deletion", () => {
    expect(levenshtein("cats", "cat")).toBe(1);
  });

  it("handles transposition (not Damerau, so 2 ops)", () => {
    expect(levenshtein("ab", "ba")).toBe(2);
  });

  it("handles longer strings correctly", () => {
    // "kitten" -> "sitting" is the classic example with edit distance 3
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("works with multi-line markdown strings", () => {
    const a = "# Title\n\nSome body text that is quite long.";
    const b = "# Title\n\nSome body text that is fairly long.";
    // 'quite' -> 'fairly': 5 subs/ops
    expect(levenshtein(a, b)).toBeGreaterThan(0);
    expect(levenshtein(a, b)).toBeLessThan(20);
  });

  it("is symmetric", () => {
    const a = "hello world";
    const b = "world hello";
    expect(levenshtein(a, b)).toBe(levenshtein(b, a));
  });

  it("handles unicode characters", () => {
    expect(levenshtein("café", "cafe")).toBe(1);
  });
});
