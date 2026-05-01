import { describe, it, expect } from "vitest";
import { parseRationale } from "@marketing/shared-types";

describe("parseRationale", () => {
  it("returns null rationale and unchanged body when no tag present", () => {
    const body = "# Title\n\nSome post copy here.";
    const { rationale, bodyCopy } = parseRationale(body);
    expect(rationale).toBeNull();
    expect(bodyCopy).toBe(body);
  });

  it("extracts rationale from the top of the body", () => {
    const body = [
      "<rationale>Drawing from: Post A (CTR 3.2%), Post B (CTR 2.1%). Pattern: replicating the problem-first hook.</rationale>",
      "",
      "# The Real Problem with Deploys",
      "",
      "Post body here.",
    ].join("\n");

    const { rationale, bodyCopy } = parseRationale(body);
    expect(rationale).toBe(
      "Drawing from: Post A (CTR 3.2%), Post B (CTR 2.1%). Pattern: replicating the problem-first hook.",
    );
    expect(bodyCopy).toContain("# The Real Problem with Deploys");
    expect(bodyCopy).not.toContain("<rationale>");
    expect(bodyCopy).not.toContain("</rationale>");
  });

  it("strips the rationale block and trims the remaining copy", () => {
    const body = "<rationale>Short note.</rationale>\n\nPost copy.";
    const { bodyCopy } = parseRationale(body);
    expect(bodyCopy).toBe("Post copy.");
  });

  it("handles multiline rationale blocks", () => {
    const body = [
      "<rationale>",
      "Drawing from: Long post (CTR 4%).",
      "Deliberately breaking the reinforce pattern.",
      "</rationale>",
      "",
      "Actual post copy.",
    ].join("\n");

    const { rationale, bodyCopy } = parseRationale(body);
    expect(rationale).toContain("Long post (CTR 4%)");
    expect(rationale).toContain("Deliberately breaking");
    expect(bodyCopy).toBe("Actual post copy.");
  });

  it("is case-insensitive for the tag", () => {
    const body = "<RATIONALE>Some insight.</RATIONALE>\n\nCopy here.";
    const { rationale, bodyCopy } = parseRationale(body);
    expect(rationale).toBe("Some insight.");
    expect(bodyCopy).toBe("Copy here.");
  });

  it("returns empty body as empty string", () => {
    const { rationale, bodyCopy } = parseRationale("");
    expect(rationale).toBeNull();
    expect(bodyCopy).toBe("");
  });

  it("only extracts the first rationale block if multiple exist", () => {
    const body = "<rationale>First.</rationale>\n\n<rationale>Second.</rationale>\n\nCopy.";
    const { rationale } = parseRationale(body);
    expect(rationale).toBe("First.");
  });

  it("handles body that is only a rationale block (no actual copy)", () => {
    const body = "<rationale>Pure rationale, no copy yet.</rationale>";
    const { rationale, bodyCopy } = parseRationale(body);
    expect(rationale).toBe("Pure rationale, no copy yet.");
    expect(bodyCopy).toBe("");
  });
});
