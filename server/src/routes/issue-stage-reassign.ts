import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { issueExecutionDecisions, issues, type Db } from "@paperclipai/db";
import { reassignIssueExecutionStageSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";
import { buildExecutionStageWakeup } from "./issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import {
  applyIssueExecutionStageReassignment,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "../services/issue-execution-policy.js";
import { requireWorkflowVersionsEnabled } from "../services/workflow-versions.js";
import { persistActivity, publishActivity, type ActivityPublication } from "../services/activity-log.js";

type StageWakeup = NonNullable<ReturnType<typeof buildExecutionStageWakeup>>;

export function issueStageReassignRoutes(
  db: Db,
  options: { heartbeat?: { wakeup: (agentId: string, wakeup: StageWakeup["wakeup"]) => Promise<unknown> } } = {},
) {
  const router = Router();
  const heartbeat = options.heartbeat ?? heartbeatService(db);

  router.post("/issues/:id/execution-policy/reassign", validate(reassignIssueExecutionStageSchema), async (req, res) => {
    await requireWorkflowVersionsEnabled(db);
    const issueId = z.string().guid().parse(req.params.id);
    const [visible] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
    if (!visible || !hasCompanyAccess(req, visible.companyId)) throw notFound("Issue not found");
    assertCompanyAccess(req, visible.companyId);
    const actor = getActorInfo(req);
    const decisionId = randomUUID();
    const publications: ActivityPublication[] = [];

    const outcome = await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      const locked = await issueService(db).getByIdForUpdate(issueId, tx);
      if (!locked) throw notFound("Issue not found");
      const previousState = parseIssueExecutionState(locked.executionState);
      const transition = applyIssueExecutionStageReassignment({
        issue: locked,
        policy: normalizeIssueExecutionPolicy(locked.executionPolicy ?? null),
        actor: { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null },
        isBoardActor: req.actor.type === "board",
        toParticipant: req.body.toParticipant,
        comment: req.body.comment,
      });
      if (!transition.changed) return { issue: locked, previousState, transition };
      const executionState = { ...(transition.patch.executionState as Record<string, unknown>), lastDecisionId: decisionId };
      const updated = await issueService(db).update(issueId, {
        ...transition.patch,
        executionState,
        actorAgentId: actor.agentId,
        actorUserId: actor.actorType === "user" ? actor.actorId : null,
        actorRunId: actor.runId,
      }, tx);
      if (!updated) throw notFound("Issue not found");
      await tx.insert(issueExecutionDecisions).values({
        id: decisionId, companyId: updated.companyId, issueId, ...transition.decision,
        actorAgentId: actor.agentId, actorUserId: actor.actorType === "user" ? actor.actorId : null,
        createdByRunId: actor.runId,
      });
      publications.push((await persistActivity(tx, {
        companyId: updated.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId,
        runId: actor.runId, action: "issue.execution_policy_reassigned", entityType: "issue", entityId: issueId,
        details: { stageId: transition.decision.stageId, stageType: transition.decision.stageType,
          toParticipant: req.body.toParticipant },
      })).publication);
      return { issue: updated, previousState, transition };
    });
    publications.forEach(publishActivity);

    if (outcome.transition.changed) {
      const stageWakeup = buildExecutionStageWakeup({
        issueId,
        previousState: outcome.previousState,
        nextState: parseIssueExecutionState(outcome.issue.executionState),
        interruptedRunId: null,
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
      });
      if (stageWakeup) {
        try {
          await heartbeat.wakeup(stageWakeup.agentId, stageWakeup.wakeup);
        } catch (error) {
          logger.warn({ err: error, issueId, agentId: stageWakeup.agentId }, "failed to enqueue execution stage reassignment wake");
        }
      }
    }
    res.json(outcome.issue);
  });

  return router;
}
