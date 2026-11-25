import { describe, expect, it } from "vitest";
import { summarizeDocumentChange } from "./workflow-run-diff.js";

describe("summarizeDocumentChange", () => {
  it("counts added and removed lines and shows the changed ones", () => {
    const summary = summarizeDocumentChange("Intro\nOld claim\nOutro", "Intro\nNew claim\nSecond source\nOutro", { maxChars: 1_000 });

    expect(summary).toContain("2 lines added, 1 removed");
    expect(summary).toContain("+ New claim");
    expect(summary).toContain("+ Second source");
    expect(summary).toContain("- Old claim");
    expect(summary).not.toContain("Intro");
  });

  it("says when nothing changed", () => {
    expect(summarizeDocumentChange("Same\ntext", "Same\ntext", { maxChars: 1_000 })).toBe("No changes");
  });

  it("treats a repeated line as changed only by the copies added or removed", () => {
    const summary = summarizeDocumentChange("Point\nPoint", "Point", { maxChars: 1_000 });

    expect(summary).toContain("0 lines added, 1 removed");
  });

  it("cuts the listing at the size limit and says so", () => {
    const longer = Array.from({ length: 200 }, (_, index) => `New line ${index}`).join("\n");

    const summary = summarizeDocumentChange("", longer, { maxChars: 300 });

    const listed = summary.split("\n").filter((line) => line.startsWith("+ ") || line.startsWith("- ")).join("\n");
    expect(listed.length).toBeLessThanOrEqual(300);
    expect(summary).toContain("200 lines added");
    expect(summary).toMatch(/more changed lines/);
  });
});
