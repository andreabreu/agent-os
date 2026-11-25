import { and, asc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { workflowRunEvents, workflowRunSteps, workflowRuns, type Db } from "@paperclipai/db";
import type { WorkflowStep } from "@paperclipai/shared";
import { persistActivity } from "./activity-log.js";
import { findStep, loadRunSpec, writeWithActivity } from "./workflow-runs.js";

const REMINDED_STATUSES = ["awaiting_approval", "awaiting_input"];
const REMINDER_BATCH = 100;
const SYSTEM_ACTOR = { actorType: "system", actorId: "workflow-run" } as const;

function reminderWithinTimeout(step: WorkflowStep, openedAt: Date, at: Date) {
  const timeoutSec = step.limits.timeoutSec;
  return !timeoutSec || at.getTime() < openedAt.getTime() + timeoutSec * 1_000;
}

/** When a person waiting on a gate or form should first be reminded, or null when the step declares no reminder. */
export function firstReminderAt(step: WorkflowStep, openedAt: Date) {
  if (!step.reminderAfterSec) return null;
  const at = new Date(openedAt.getTime() + step.reminderAfterSec * 1_000);
  return reminderWithinTimeout(step, openedAt, at) ? at : null;
}

/**
 * Reminds the people a gate or form waits for, once per declared interval, and never decides or answers anything.
 * Each reminder is a `gate_reminder` event keyed by its interval, so a repeated pass sends it only once.
 * Reminders stop at the step's declared timeout.
 */
export async function sendDueWorkflowReminders(db: Db, now = new Date()) {
  const due = await db.select({ step: workflowRunSteps, run: workflowRuns }).from(workflowRunSteps)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowRunSteps.runId))
    .where(and(inArray(workflowRunSteps.status, REMINDED_STATUSES), lte(workflowRunSteps.remindAt, now),
      eq(workflowRuns.status, "waiting_human")))
    .limit(REMINDER_BATCH);
  for (const { step, run } of due) {
    const definition = findStep(await loadRunSpec(db, run), step.stepKey);
    const intervalMs = (definition.reminderAfterSec ?? 0) * 1_000;
    if (intervalMs <= 0) continue;
    const interval = Math.floor((now.getTime() - step.openedAt.getTime()) / intervalMs);
    const nextAt = new Date(step.openedAt.getTime() + (interval + 1) * intervalMs);
    const deciderUserIds = definition.owner.kind === "user" ? [definition.owner.ref] : [];
    const deciderRoles = definition.owner.kind === "role" ? [definition.owner.ref] : [];
    await writeWithActivity(db, async (tx, publications) => {
      const [current] = await tx.select().from(workflowRunSteps).where(eq(workflowRunSteps.id, step.id)).for("update");
      if (!current?.remindAt || current.remindAt > now || !REMINDED_STATUSES.includes(current.status)) return;
      await tx.update(workflowRunSteps)
        .set({ remindAt: reminderWithinTimeout(definition, step.openedAt, nextAt) ? nextAt : null })
        .where(eq(workflowRunSteps.id, step.id));
      const inserted = await tx.insert(workflowRunEvents).values({ runId: run.id, companyId: run.companyId,
        eventKey: `reminder:${step.id}:${interval}`, kind: "gate_reminder", ...SYSTEM_ACTOR,
        payload: { stepKey: step.stepKey, attempt: step.attempt, interval, deciderUserIds, deciderRoles,
          waitingMs: now.getTime() - step.openedAt.getTime() } })
        .onConflictDoNothing().returning({ id: workflowRunEvents.id });
      if (inserted.length === 0) return;
      publications.push((await persistActivity(tx, { companyId: run.companyId, ...SYSTEM_ACTOR, runId: null,
        action: "workflow_run.gate_reminder", entityType: "workflow_run", entityId: run.id,
        details: { stepKey: step.stepKey, attempt: step.attempt, deciderUserIds, deciderRoles,
          ...(step.decisionId ? { decisionId: step.decisionId } : {}) } })).publication);
    });
  }
}

async function earliest(db: Db, column: typeof workflowRunSteps.dueAt | typeof workflowRunSteps.remindAt, statuses: string[]) {
  const [row] = await db.select({ at: column }).from(workflowRunSteps)
    .where(and(inArray(workflowRunSteps.status, statuses), isNotNull(column)))
    .orderBy(asc(column)).limit(1);
  return row?.at?.getTime() ?? null;
}

/** The next form timeout or reminder, which schedules the recovery pass without polling. */
export async function nextWorkflowStepDeadline(db: Db) {
  const times = [await earliest(db, workflowRunSteps.dueAt, ["awaiting_input"]),
    await earliest(db, workflowRunSteps.remindAt, REMINDED_STATUSES)].filter((time): time is number => time !== null);
  return times.length ? Math.min(...times) : null;
}
