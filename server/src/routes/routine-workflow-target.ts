import { Router, type Request } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { routines, type Db } from "@paperclipai/db";
import { setRoutineWorkflowTargetSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound } from "../errors.js";
import { assertCompanyAccess, hasCompanyAccess } from "./authz.js";
import { requireWorkflowVersionsEnabled } from "../services/workflow-versions.js";
import { workflowRoutineTargetService } from "../services/workflow-routine-targets.js";

export function routineWorkflowTargetRoutes(db: Db) {
  const router = Router();
  const service = workflowRoutineTargetService(db);

  async function visibleRoutine(req: Request) {
    await requireWorkflowVersionsEnabled(db);
    const routineId = z.string().guid().parse(req.params.id);
    const [routine] = await db.select({ id: routines.id, companyId: routines.companyId, assigneeAgentId: routines.assigneeAgentId })
      .from(routines).where(eq(routines.id, routineId));
    if (!routine || !hasCompanyAccess(req, routine.companyId)) throw notFound("Routine not found");
    assertCompanyAccess(req, routine.companyId);
    return routine;
  }

  function assertCanManage(req: Request, routine: { assigneeAgentId: string | null }) {
    if (req.actor.type === "board") return;
    if (req.actor.type === "agent" && req.actor.agentId && req.actor.agentId === routine.assigneeAgentId) return;
    throw forbidden("Only board users, or the agent that runs the routine, can change its workflow target");
  }

  router.get("/routines/:id/workflow-target", async (req, res) => {
    const routine = await visibleRoutine(req);
    res.json(await service.getTarget(routine.companyId, routine.id));
  });

  router.put("/routines/:id/workflow-target", validate(setRoutineWorkflowTargetSchema), async (req, res) => {
    const routine = await visibleRoutine(req);
    assertCanManage(req, routine);
    res.json(await service.setTarget(routine.companyId, routine.id, req.body.workflowId, req.actor));
  });

  router.delete("/routines/:id/workflow-target", async (req, res) => {
    const routine = await visibleRoutine(req);
    assertCanManage(req, routine);
    await service.removeTarget(routine.companyId, routine.id, req.actor);
    res.status(204).end();
  });

  return router;
}
