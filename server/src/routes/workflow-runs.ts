import { Router, type Request } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { workflowRuns, type Db } from "@paperclipai/db";
import { completeWorkflowStepSchema, listWorkflowRunsSchema, startWorkflowRunSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { notFound } from "../errors.js";
import { assertCompanyAccess, hasCompanyAccess } from "./authz.js";
import { requireWorkflowVersionsEnabled } from "../services/workflow-versions.js";
import { workflowRunService } from "../services/workflow-runs.js";
import { completeWorkflowStep } from "../services/workflow-run-advance.js";

const stepKeyParamSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export function workflowRunRoutes(db: Db) {
  const router = Router();
  const service = workflowRunService(db);

  async function runCompany(req: Request) {
    await requireWorkflowVersionsEnabled(db);
    const runId = z.string().guid().parse(req.params.id);
    const [run] = await db.select({ companyId: workflowRuns.companyId }).from(workflowRuns).where(eq(workflowRuns.id, runId));
    if (!run || !hasCompanyAccess(req, run.companyId)) throw notFound("Workflow run not found");
    assertCompanyAccess(req, run.companyId);
    return { runId, companyId: run.companyId };
  }

  router.post("/companies/:companyId/workflow-runs", validate(startWorkflowRunSchema), async (req, res) => {
    await requireWorkflowVersionsEnabled(db);
    const companyId = z.string().guid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    res.status(201).json(await service.start(companyId, req.actor, req.body));
  });

  router.get("/companies/:companyId/workflow-runs", async (req, res) => {
    await requireWorkflowVersionsEnabled(db);
    const companyId = z.string().guid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    res.json(await service.list(companyId, listWorkflowRunsSchema.parse(req.query)));
  });

  router.get("/workflow-runs/:id", async (req, res) => {
    const { runId, companyId } = await runCompany(req);
    res.json(await service.read(companyId, runId));
  });

  router.post("/workflow-runs/:id/steps/:stepKey/complete", validate(completeWorkflowStepSchema), async (req, res) => {
    const { runId, companyId } = await runCompany(req);
    const stepKey = stepKeyParamSchema.parse(req.params.stepKey);
    res.json(await completeWorkflowStep(db, companyId, runId, stepKey, req.actor, req.body));
  });

  return router;
}
