import { describe, it, expect } from "vitest";
import {
  canTransitionContent,
  canTransitionAsset,
  assertContentTransition,
  InvalidTransitionError,
} from "./state-machine";

describe("content transitions", () => {
  it("allows draft -> in_review -> approved", () => {
    expect(canTransitionContent("draft", "in_review")).toBe(true);
    expect(canTransitionContent("in_review", "approved")).toBe(true);
  });

  it("allows in_review -> draft (changes_requested rolls back)", () => {
    expect(canTransitionContent("in_review", "draft")).toBe(true);
  });

  it("forbids draft -> approved (must go through review)", () => {
    expect(canTransitionContent("draft", "approved")).toBe(false);
  });

  it("forbids draft -> published", () => {
    expect(canTransitionContent("draft", "published")).toBe(false);
  });

  it("forbids retracted -> anything", () => {
    expect(canTransitionContent("retracted", "draft")).toBe(false);
    expect(canTransitionContent("retracted", "published")).toBe(false);
  });

  it("forbids no-op transitions", () => {
    expect(canTransitionContent("draft", "draft")).toBe(false);
  });

  it("approved -> scheduled is allowed (the publish gate path)", () => {
    expect(canTransitionContent("approved", "scheduled")).toBe(true);
  });

  it("scheduled -> published is allowed", () => {
    expect(canTransitionContent("scheduled", "published")).toBe(true);
  });

  it("assertContentTransition throws InvalidTransitionError on bad path", () => {
    expect(() => assertContentTransition("draft", "approved")).toThrow(
      InvalidTransitionError,
    );
  });
});

describe("asset transitions", () => {
  it("draft -> in_review -> approved -> published", () => {
    expect(canTransitionAsset("draft", "in_review")).toBe(true);
    expect(canTransitionAsset("in_review", "approved")).toBe(true);
    expect(canTransitionAsset("approved", "published")).toBe(true);
  });

  it("forbids draft -> approved", () => {
    expect(canTransitionAsset("draft", "approved")).toBe(false);
  });
});
