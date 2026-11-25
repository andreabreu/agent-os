import { and, asc, eq } from "drizzle-orm";
import { workflowRunSteps, type Db } from "@paperclipai/db";
import { documentService } from "./documents.js";

const SUMMARY_MAX_CHARS = 2_000;

function lineCounts(lines: string[]) {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

function surplus(from: string[], against: Map<string, number>) {
  const remaining = new Map(against);
  const extra: string[] = [];
  for (const line of from) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) remaining.set(line, left - 1);
    else extra.push(line);
  }
  return extra;
}

/**
 * A short, line-based summary of how a document changed, for a reviewer who saw the previous round.
 * Repeated lines count by copy. The listing stops at the size limit.
 * @param oldBody The body the reviewer saw last round
 * @param newBody The body under review now
 * @param options.maxChars Upper bound for the listed lines
 */
export function summarizeDocumentChange(oldBody: string, newBody: string, options: { maxChars: number }) {
  const oldLines = oldBody.split("\n").filter((line) => line.trim() !== "");
  const newLines = newBody.split("\n").filter((line) => line.trim() !== "");
  const added = surplus(newLines, lineCounts(oldLines));
  const removed = surplus(oldLines, lineCounts(newLines));
  if (added.length === 0 && removed.length === 0) return "No changes";
  const listing = [...added.map((line) => `+ ${line}`), ...removed.map((line) => `- ${line}`)];
  const shown: string[] = [];
  let size = 0;
  for (const line of listing) {
    if (size + line.length + 1 > options.maxChars) break;
    shown.push(line);
    size += line.length + 1;
  }
  const hidden = listing.length - shown.length;
  return [
    `${added.length} lines added, ${removed.length} removed`,
    ...shown,
    ...(hidden > 0 ? [`… ${hidden} more changed lines`] : []),
  ].join("\n");
}

/**
 * What changed in a run's output documents between the last two rounds that produced them.
 * @returns A summary per changed document, or null when no document has two rounds yet
 */
export async function summarizeAttemptChanges(db: Db, input: {
  runId: string;
  taskId: string;
  /** Outputs of the step finishing right now, not yet written to its row. */
  latestOutputs?: Record<string, string>;
}) {
  const completed = await db.select({ outputRevisionIds: workflowRunSteps.outputRevisionIds }).from(workflowRunSteps)
    .where(and(eq(workflowRunSteps.runId, input.runId), eq(workflowRunSteps.status, "completed")))
    .orderBy(asc(workflowRunSteps.closedAt));
  const revisionsByKey = new Map<string, string[]>();
  for (const step of [...completed, { outputRevisionIds: input.latestOutputs ?? {} }]) {
    for (const [key, revisionId] of Object.entries(step.outputRevisionIds ?? {})) {
      const seen = revisionsByKey.get(key) ?? [];
      if (seen.at(-1) !== revisionId) seen.push(revisionId);
      revisionsByKey.set(key, seen);
    }
  }
  const sections: string[] = [];
  for (const [key, revisions] of revisionsByKey) {
    if (revisions.length < 2) continue;
    const [previous, current] = await Promise.all(revisions.slice(-2).map((revisionId) =>
      documentService(db).getIssueDocumentRevision(input.taskId, key, revisionId)));
    if (!previous || !current) continue;
    sections.push(`Document "${key}": ${summarizeDocumentChange(previous.body, current.body, { maxChars: SUMMARY_MAX_CHARS })}`);
  }
  return sections.length ? sections.join("\n\n") : null;
}
