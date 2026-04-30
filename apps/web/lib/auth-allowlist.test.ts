import { afterEach, describe, expect, it } from "vitest";
import { isAllowed } from "./auth-allowlist";

const original = process.env.AUTH_ALLOWLIST;
afterEach(() => {
  if (original === undefined) delete process.env.AUTH_ALLOWLIST;
  else process.env.AUTH_ALLOWLIST = original;
});

describe("isAllowed", () => {
  it("allows matching domain (case-insensitive)", () => {
    process.env.AUTH_ALLOWLIST = "venture23.io,ibriz.com";
    expect(isAllowed("alice@venture23.io")).toBe(true);
    expect(isAllowed("Alice@VENTURE23.IO")).toBe(true);
    expect(isAllowed("bob@ibriz.com")).toBe(true);
  });

  it("allows exact email match", () => {
    process.env.AUTH_ALLOWLIST = "team@example.com,venture23.io";
    expect(isAllowed("team@example.com")).toBe(true);
    expect(isAllowed("other@example.com")).toBe(false);
  });

  it("rejects when domain doesn't match", () => {
    process.env.AUTH_ALLOWLIST = "venture23.io";
    expect(isAllowed("eve@evil.com")).toBe(false);
  });

  it("fails closed on empty allowlist", () => {
    process.env.AUTH_ALLOWLIST = "";
    expect(isAllowed("alice@venture23.io")).toBe(false);
  });

  it("fails closed on null/undefined email", () => {
    process.env.AUTH_ALLOWLIST = "venture23.io";
    expect(isAllowed(null)).toBe(false);
    expect(isAllowed(undefined)).toBe(false);
    expect(isAllowed("")).toBe(false);
  });

  it("doesn't allow substring spoofing (alice@notventure23.io)", () => {
    process.env.AUTH_ALLOWLIST = "venture23.io";
    expect(isAllowed("alice@notventure23.io")).toBe(false);
  });
});
