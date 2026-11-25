import { Router } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { workflowVersions, workflows, type Db } from "@paperclipai/db";
import { simulateWorkflow, simulateWorkflowSchema, validateWorkflowGraph, workflowSpecSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { notFound, unprocessable } from "../errors.js";
import { assertCompanyAccess, hasCompanyAccess } from "./authz.js";
import { requireWorkflowVersionsEnabled } from "../services/workflow-versions.js";

export function workflowSimulateRoutes(db: Db) {
  const router = Router();

  router.post("/workflows/:id/simulate", validate(simulateWorkflowSchema), async (req, res) => {
    await requireWorkflowVersionsEnabled(db);
    const workflowId = z.string().guid().parse(req.params.id);
    const [workflow] = await db.select({ companyId: workflows.companyId }).from(workflows).where(eq(workflows.id, workflowId));
    if (!workflow || !hasCompanyAccess(req, workflow.companyId)) throw notFound("Workflow not found");
    assertCompanyAccess(req, workflow.companyId);

    let rawSpec = req.body.spec;
    if (rawSpec === undefined) {
      const [version] = await db.select({ spec: workflowVersions.spec }).from(workflowVersions).where(and(
        eq(workflowVersions.workflowId, workflowId),
        req.body.versionNumber ? eq(workflowVersions.version, req.body.versionNumber) : undefined,
      )).orderBy(desc(workflowVersions.version)).limit(1);
      if (!version) throw notFound("Workflow version not found");
      rawSpec = version.spec;
    }
    const parsed = workflowSpecSchema.safeParse(rawSpec);
    if (!parsed.success) throw unprocessable("The spec to simulate is malformed", { code: "invalid_workflow_spec", issues: parsed.error.issues });
    const issues = validateWorkflowGraph(parsed.data);
    if (issues.length > 0) throw unprocessable("Workflow spec is not a valid graph", { code: "invalid_workflow_graph", issues });
    res.json(simulateWorkflow(parsed.data, req.body.script));
  });

  return router;
}
