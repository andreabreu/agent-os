import { describe, expect, it } from "vitest";
import { formAnswersMarkdown, validateFormAnswers } from "./workflow-form.js";
import { workflowFormQuestionSchema } from "./workflow-spec.js";

const questions = [
  { id: "audience", label: "Who is the audience?", kind: "text", required: true },
  { id: "tone", label: "Tone", kind: "single_choice", required: true, options: ["formal", "casual"] },
  { id: "channels", label: "Channels", kind: "multi_choice", options: ["blog", "email", "social"] },
  { id: "words", label: "Word count", kind: "number" },
  { id: "due", label: "Due date", kind: "date" },
].map((question) => workflowFormQuestionSchema.parse(question));

describe("validateFormAnswers", () => {
  it("accepts complete answers and normalizes them", () => {
    const result = validateFormAnswers(questions, {
      audience: "  Founders  ", tone: "casual", channels: ["blog", "email"], words: "800", due: "2026-12-01",
    });

    expect(result).toEqual({ ok: true, answers: {
      audience: "Founders", tone: "casual", channels: ["blog", "email"], words: 800, due: "2026-12-01",
    } });
  });

  it("lists every required question that is missing", () => {
    const result = validateFormAnswers(questions, { audience: " ", channels: [] });

    expect(result).toMatchObject({ ok: false, missingRequired: ["audience", "tone"] });
  });

  it("refuses answers outside the allowed shape of each kind", () => {
    const result = validateFormAnswers(questions, {
      audience: "Founders", tone: "loud", channels: ["blog", "fax"], words: "many", due: "next week",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.invalid.map((item) => item.id).sort()).toEqual(["channels", "due", "tone", "words"]);
  });

  it("accepts empty optional answers and ignores unknown ones", () => {
    const result = validateFormAnswers(questions, { audience: "Founders", tone: "formal", extra: "ignored" });

    expect(result).toEqual({ ok: true, answers: { audience: "Founders", tone: "formal" } });
  });

  it("renders the answers as a readable document", () => {
    const markdown = formAnswersMarkdown("Brief", questions, { audience: "Founders", tone: "formal", channels: ["blog"] });

    expect(markdown).toContain("# Brief");
    expect(markdown).toContain("**Who is the audience?**");
    expect(markdown).toContain("Founders");
    expect(markdown).toContain("blog");
  });
});
