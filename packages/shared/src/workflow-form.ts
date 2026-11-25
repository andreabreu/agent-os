import type { WorkflowFormQuestion } from "./workflow-spec.js";

export type FormAnswerValue = string | number | string[];
export type FormAnswers = Record<string, FormAnswerValue>;

export type FormValidation =
  | { ok: true; answers: FormAnswers }
  | { ok: false; missingRequired: string[]; invalid: { id: string; reason: string }[] };

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isBlank(value: unknown) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "")
    || (Array.isArray(value) && value.length === 0);
}

function isRealDate(value: string) {
  return ISO_DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

function normalizeAnswer(question: WorkflowFormQuestion, value: unknown): FormAnswerValue | { invalid: string } {
  if (question.kind === "text") return typeof value === "string" ? value.trim() : { invalid: "expected text" };
  if (question.kind === "number") {
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
    return Number.isFinite(number) ? number : { invalid: "expected a number" };
  }
  if (question.kind === "date") {
    return typeof value === "string" && isRealDate(value.trim()) ? value.trim() : { invalid: "expected a date as YYYY-MM-DD" };
  }
  const options = question.options ?? [];
  if (question.kind === "single_choice") {
    return typeof value === "string" && options.includes(value) ? value : { invalid: `expected one of ${options.join(", ")}` };
  }
  const values = Array.isArray(value) ? value : [value];
  return values.every((item) => typeof item === "string" && options.includes(item))
    ? values as string[]
    : { invalid: `expected only ${options.join(", ")}` };
}

/**
 * Checks a person's answers against the questions of a form step.
 * Required questions must be answered, every answer must fit its kind, and unknown answers are dropped.
 * @param questions The form step's declared questions
 * @param answers The submitted answers by question id
 */
export function validateFormAnswers(questions: WorkflowFormQuestion[], answers: Record<string, unknown>): FormValidation {
  const missingRequired: string[] = [];
  const invalid: { id: string; reason: string }[] = [];
  const normalized: FormAnswers = {};
  for (const question of questions) {
    const value = answers[question.id];
    if (isBlank(value)) {
      if (question.required) missingRequired.push(question.id);
      continue;
    }
    const answer = normalizeAnswer(question, value);
    if (typeof answer === "object" && !Array.isArray(answer)) invalid.push({ id: question.id, reason: answer.invalid });
    else normalized[question.id] = answer;
  }
  return missingRequired.length || invalid.length ? { ok: false, missingRequired, invalid } : { ok: true, answers: normalized };
}

/** The document a form step's answers are saved as, so later steps can read them. */
export function formAnswersMarkdown(title: string, questions: WorkflowFormQuestion[], answers: FormAnswers) {
  const sections = questions.filter((question) => answers[question.id] !== undefined).map((question) => {
    const value = answers[question.id]!;
    return `**${question.label}**\n\n${Array.isArray(value) ? value.map((item) => `- ${item}`).join("\n") : String(value)}`;
  });
  return [`# ${title}`, ...sections].join("\n\n");
}
